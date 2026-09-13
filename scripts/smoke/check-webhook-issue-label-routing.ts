#!/usr/bin/env bun
/**
 * Shipping-path E2E for labeled-Issue webhook routing (Issue #1643 PR-1):
 * `POST /webhooks/github` (real Hono route) -> enqueue -> async job queue ->
 * `createInboundEventJobHandler` -> `resolveTargets` -> handlers.
 *
 * FREE AND DETERMINISTIC -- no `claude` CLI, no provider key, no LLM turn
 * anywhere in this path. The exception here is cost, not gate placement,
 * same convention as `check-restore-failure-declaration.ts`'s header.
 *
 * ============================================================================
 * WHY A REAL CHILD PROCESS, NOT AN IN-PROCESS `import()`
 * ============================================================================
 *
 * Every other "disposable server" smoke in this repo boots via
 * `await import('../../packages/server/src/index.ts')` in the SAME process
 * as the script. That pattern does not work here: this smoke needs to
 * capture an actual pino log line as proof that the "non-matching label ->
 * zero targets" path really executed (not silence indistinguishable from a
 * broken harness -- `workflow.md`'s sub-pattern 9/5 discipline). Pino's
 * default destination (`sonic-boom`, writing directly to fd 1 via
 * `fs.writeSync`) and pino-pretty's dev-mode worker thread (which also
 * writes directly to fd 1) BYPASS `process.stdout.write` at the JS level
 * entirely -- monkey-patching `process.stdout.write` in an in-process boot
 * cannot intercept it. The only reliable capture mechanism is a real OS
 * pipe, which means spawning the server as a genuine child process with
 * `stdout: 'pipe'` and reading its stream.
 *
 * ============================================================================
 * WHAT THIS SCRIPT VERIFIES
 * ============================================================================
 *
 * Four webhook scenarios against the SAME registered repository, all in one
 * run:
 *
 *   1. POSITIVE CONTROL: `issues` `closed` action. Unaffected by this PR --
 *      fans out via the OLD per-session loop to every worktree session of
 *      the repository (D and T), never to the `quick` delegate session.
 *      Confirmed via a direct read of the disposable server's own SQLite
 *      file for `inbound_event_notifications` rows.
 *
 *   2. NEGATIVE CONTROL: `issues` `labeled` action, a label that does NOT
 *      match the repository's configured trigger label. Zero notification
 *      rows for this event, and the server's own stdout contains the exact
 *      log message `resolveIssueLabeledTargets` (resolve-targets.ts) emits
 *      when the labels do not match -- proof the code path executed rather
 *      than merely produced no observable effect.
 *
 *   3. POSITIVE: `issues` `labeled` action, a matching label (deliberately
 *      cased differently than the repository's configured trigger-label
 *      config, exercising `matchesAnyTriggerLabel`'s case-insensitive
 *      compare rather than an exact-string match a naive `===` would also
 *      pass). Routes exclusively to D (the designated Orchestrator session)
 *      -- confirmed by reading D's real worker output file for the
 *      `[inbound:issue:labeled]` PTY-notification tag. T (a plain worktree
 *      session of the same repository) and the delegate (a `quick` child
 *      session of D) must NOT receive it -- this is the whole point of R2's
 *      early-return replacing the old per-session fan-out for this event
 *      type.
 *
 *   4. POSITIVE: `issues` `opened` action with a label set (not `labeled`'s
 *      single added-label shape) that includes the matching trigger label
 *      among others -- exercises `parseIssueOpened`'s full-label-set
 *      matching path, distinct from scenario 3's added-label-only path.
 *      Same D-only assertion shape as scenario 3, on a different issue
 *      number so the two are distinguishable if debugging is needed.
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 *
 *   - a real disposable server process (`bun packages/server/src/index.ts`),
 *     booted exactly as `bun run dev` would, under a disposable
 *     `AGENT_CONSOLE_HOME`;
 *   - a real, signed GitHub webhook payload (HMAC-SHA256, matching
 *     `GitHubServiceParser.authenticate` byte-for-byte) posted over real
 *     HTTP to the real `/webhooks/github` route;
 *   - the real async job queue (`appContext.jobQueue.enqueue`), the real
 *     `createInboundEventJobHandler`, the real `resolveTargets`, and the
 *     real `AgentWorkerHandler` / `UINotificationHandler`;
 *   - a real disposable git repository with a real `origin` remote, real
 *     `git worktree add` worktrees for D and T, and real
 *     `getOrgRepoFromPath` remote-URL resolution (local-only, no network);
 *   - real sessions and real PTY-backed `agent` workers created via the
 *     real `POST /api/sessions` route (the default `claude-code-builtin`
 *     agent, spawned interactively with no prompt sent -- no LLM API call);
 *   - a real `set_orchestrator_session` MCP call over real `/mcp` JSON-RPC.
 *
 * Usage:
 *   bun scripts/smoke/check-webhook-issue-label-routing.ts
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (a real regression)
 *   2  bad usage / the smoke could not run (server failed to boot, git
 *      commands failed, etc.)
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Mini assertion harness -- same shape as this repo's other server-story
// smokes (e.g. `check-artifact-server-story-e2e.mjs`).
// ---------------------------------------------------------------------------
const failures: string[] = [];
let passes = 0;

function expect(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

class BailError extends Error {}
function bail(message: string): never {
  throw new BailError(message);
}

/** Find a free TCP port by letting the OS assign one, then releasing it. */
function getFreePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Poll GET /health until the disposable server accepts connections. */
async function waitForServerReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(150);
  }
  bail(`Disposable server did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Poll `cond` until it returns true or the timeout elapses. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await Bun.sleep(200);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

function signWebhookPayload(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

async function postWebhook(baseUrl: string, githubEvent: string, bodyObj: unknown, secret: string): Promise<Response> {
  const bodyString = JSON.stringify(bodyObj);
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': githubEvent,
      'x-hub-signature-256': signWebhookPayload(bodyString, secret),
    },
    body: bodyString,
  });
}

/** Run a git command synchronously; bail loudly on a non-zero exit. */
function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    bail(`git ${args.join(' ')} (cwd=${cwd}) failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers -- real HTTP against the disposable server's own
// /mcp endpoint, same pattern as `check-artifact-server-story-e2e.mjs`.
// ---------------------------------------------------------------------------
async function initializeMcp(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'webhook-issue-label-routing-smoke', version: '1.0.0' } },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callMcpTool(baseUrl: string, mcpSessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 2 }),
  });
  const json = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  const text = json.result?.content?.[0]?.text;
  if (json.result?.isError) {
    bail(`MCP tool ${name} returned an error result: ${text}`);
  }
  if (!text) {
    bail(`MCP tool ${name} returned no text content: ${JSON.stringify(json)}`);
  }
  return JSON.parse(text);
}

interface CreatedSession {
  id: string;
  workers: { id: string; type: string }[];
}

async function createSession(baseUrl: string, body: Record<string, unknown>): Promise<CreatedSession> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    bail(`Session creation failed (status ${res.status}, body=${JSON.stringify(body)}): ${await res.text()}`);
  }
  const { session } = (await res.json()) as { session: CreatedSession };
  return session;
}

async function main(): Promise<void> {
  process.chdir(REPO_ROOT);

  const runId = `${process.pid}-${Date.now()}`;
  const scratchRoot = path.join(os.tmpdir(), `agent-console-webhook-label-smoke-${runId}`);
  const disposableHome = path.join(scratchRoot, 'home');
  const repoDir = path.join(scratchRoot, 'repo');
  const worktreeDDir = path.join(scratchRoot, 'worktree-d');
  const worktreeTDir = path.join(scratchRoot, 'worktree-t');
  mkdirSync(disposableHome, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  console.log(`==> scratch root: ${scratchRoot}`);

  const port = getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webhookSecret = `smoke-webhook-secret-${runId}`;
  const nonceOrg = `smoke-org-${process.pid}`;
  const nonceRepo = `smoke-repo-${process.pid}`;
  const configuredTriggerLabel = `Smoke-Trigger-${process.pid}`; // deliberately mixed case
  const webhookTriggerLabel = `smoke-trigger-${process.pid}`; // different case than config

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stdoutBuf = '';
  let stderrBuf = '';

  try {
    // -----------------------------------------------------------------
    // Disposable git repository with a real `origin` remote.
    // -----------------------------------------------------------------
    console.log('==> setting up disposable git repository with a fake origin remote');
    git(['init', '-q'], repoDir);
    git(['config', 'user.email', 'smoke@example.com'], repoDir);
    git(['config', 'user.name', 'Smoke Test'], repoDir);
    git(['commit', '--allow-empty', '-q', '-m', 'init'], repoDir);
    git(['remote', 'add', 'origin', `https://github.com/${nonceOrg}/${nonceRepo}.git`], repoDir);
    git(['worktree', 'add', worktreeDDir, '-b', 'smoke-branch-d'], repoDir);
    git(['worktree', 'add', worktreeTDir, '-b', 'smoke-branch-t'], repoDir);

    // -----------------------------------------------------------------
    // Real interactive `claude` CLI trust-dialog bypass.
    //
    // A brand-new working directory the real `claude` CLI has never seen
    // triggers its "Do you trust the files in this folder?" TUI prompt at
    // startup, which blocks indefinitely with no automatic resolution --
    // this is a real, load-bearing property of the shipping interactive
    // terminal-agent path (unlike `claude-sdk` embedded-agent workers,
    // which use the SDK's `permissionMode` and never show this prompt; no
    // other smoke in this repo hits it). Bypassed the same way an operator
    // would pre-trust a directory: seed an ISOLATED `CLAUDE_CONFIG_DIR`
    // (never the real OS user's own `~/.claude.json`, so this smoke has no
    // persistent side effect on the host) with a `projects` entry per
    // worktree path, `hasTrustDialogAccepted: true`.
    //
    // The isolated config is a COPY of the real user's `~/.claude.json`,
    // not a from-scratch file -- a from-scratch file lacks
    // `hasCompletedOnboarding` and the theme/model preferences, so the CLI
    // instead runs its full first-run onboarding wizard (theme picker,
    // etc.), which is an equally-blocking prompt this smoke would then
    // need to bypass too. Copying the already-onboarded, already
    // authenticated real config and only ADDING the new project entries
    // sidesteps both prompts in one step. (Credentials themselves are
    // unaffected either way -- `CLAUDE_CONFIG_DIR` does not relocate
    // `claude login`'s credential store, confirmed empirically.)
    // -----------------------------------------------------------------
    console.log('==> seeding an isolated CLAUDE_CONFIG_DIR with pre-trusted worktree paths');
    const claudeConfigDir = path.join(scratchRoot, 'claude-config');
    mkdirSync(claudeConfigDir, { recursive: true });
    const realClaudeConfigPath = path.join(os.homedir(), '.claude.json');
    let baseClaudeConfig: Record<string, unknown> = {};
    try {
      baseClaudeConfig = JSON.parse(readFileSync(realClaudeConfigPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // No real ~/.claude.json (e.g. `claude` never run as this OS user) --
      // proceed with an empty base; the trust-dialog bypass below still
      // applies, though onboarding may then also appear.
    }
    const isolatedClaudeConfig = {
      ...baseClaudeConfig,
      projects: {
        ...(baseClaudeConfig.projects as Record<string, unknown> | undefined),
        [worktreeDDir]: { hasTrustDialogAccepted: true },
        [worktreeTDir]: { hasTrustDialogAccepted: true },
      },
    };
    writeFileSync(path.join(claudeConfigDir, '.claude.json'), JSON.stringify(isolatedClaudeConfig));

    // -----------------------------------------------------------------
    // Server bring-up: real child process (see header comment for why).
    // -----------------------------------------------------------------
    console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);
    console.log(`==> disposable server target: ${baseUrl}`);

    proc = Bun.spawn({
      cmd: ['bun', 'packages/server/src/index.ts'],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGENT_CONSOLE_HOME: disposableHome,
        AUTH_MODE: 'none',
        PORT: String(port),
        HOST: '127.0.0.1',
        GITHUB_WEBHOOK_SECRET: webhookSecret,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const decoder = new TextDecoder();
    const readStdout = (async () => {
      for await (const chunk of proc!.stdout as ReadableStream<Uint8Array>) {
        stdoutBuf += decoder.decode(chunk);
      }
    })();
    const readStderr = (async () => {
      for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) {
        stderrBuf += decoder.decode(chunk);
      }
    })();
    void readStdout;
    void readStderr;

    await waitForServerReady(baseUrl);
    console.log('==> disposable server is ready');

    // getDbPath() imported live (env already set for THIS process too) so
    // this script's own DB-path resolution can never drift from
    // `lib/config.ts`'s actual logic. Also used below for
    // `computeSessionDataBaseDir` (worker output file path derivation).
    process.env.AGENT_CONSOLE_HOME = disposableHome;
    const configModule = await import('../../packages/server/src/lib/config.ts');
    const { computeSessionDataBaseDir } = await import('../../packages/server/src/lib/session-data-path.ts');
    const { SessionDataPathResolver } = await import('../../packages/server/src/lib/session-data-path-resolver.ts');
    const dbPath = configModule.getDbPath();

    // -----------------------------------------------------------------
    // Repository registration + trigger-label configuration.
    // -----------------------------------------------------------------
    console.log('\n==> registering repository + configuring trigger label');
    const registerRes = await fetch(`${baseUrl}/api/repositories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoDir, description: 'webhook-issue-label-routing smoke' }),
    });
    if (!registerRes.ok) bail(`Repository registration failed (status ${registerRes.status}): ${await registerRes.text()}`);
    const { repository } = (await registerRes.json()) as { repository: { id: string } };
    console.log(`==> repository registered: ${repository.id}`);

    const patchRes = await fetch(`${baseUrl}/api/repositories/${repository.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueTriggerLabels: configuredTriggerLabel }),
    });
    if (!patchRes.ok) bail(`Repository trigger-label PATCH failed (status ${patchRes.status}): ${await patchRes.text()}`);
    console.log(`==> trigger label configured: '${configuredTriggerLabel}' (webhook will use differently-cased '${webhookTriggerLabel}')`);

    // -----------------------------------------------------------------
    // Sessions D, T (real worktree sessions), and a delegate (quick child
    // of D). No agentId is passed -- session-manager.ts's createSession
    // defaults `request.agentId ?? CLAUDE_CODE_AGENT_ID` unconditionally
    // for worktree sessions, so every worktree session gets a real
    // interactive `claude` PTY worker with no prompt ever sent (no LLM
    // API call, no cost).
    // -----------------------------------------------------------------
    console.log('\n==> creating sessions D (designated orchestrator) and T (plain worktree)');
    const sessionD = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-d',
      locationPath: worktreeDDir,
    });
    console.log(`==> session D created: ${sessionD.id} (workers: ${JSON.stringify(sessionD.workers.map((w) => w.type))})`);

    const sessionT = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-t',
      locationPath: worktreeTDir,
    });
    console.log(`==> session T created: ${sessionT.id} (workers: ${JSON.stringify(sessionT.workers.map((w) => w.type))})`);

    const delegateSession = await createSession(baseUrl, {
      type: 'quick',
      locationPath: repoDir,
      parentSessionId: sessionD.id,
    });
    console.log(`==> delegate session created: ${delegateSession.id} (parentSessionId=${sessionD.id})`);

    const agentWorkerD = sessionD.workers.find((w) => w.type === 'agent');
    const agentWorkerT = sessionT.workers.find((w) => w.type === 'agent');
    if (!agentWorkerD) bail('session D has no agent worker');
    if (!agentWorkerT) bail('session T has no agent worker');

    // -----------------------------------------------------------------
    // Designate D as the repository's Orchestrator via a real MCP call.
    // -----------------------------------------------------------------
    console.log('\n==> designating D as the repository Orchestrator via set_orchestrator_session');
    const mcpSessionId = await initializeMcp(baseUrl);
    const designateResult = (await callMcpTool(baseUrl, mcpSessionId, 'set_orchestrator_session', {
      sessionId: sessionD.id,
    })) as { repositoryId: string; orchestratorSessionId: string };
    expect(designateResult.orchestratorSessionId === sessionD.id, 'set_orchestrator_session designates D', JSON.stringify(designateResult));

    // -----------------------------------------------------------------
    // Worker output file path derivation -- read `data_scope` /
    // `data_scope_slug` directly from the disposable server's own SQLite
    // file (the same source of truth `SessionManager.getPathResolverForSessionId`
    // reads from in-process) and feed them into the SAME pure path-resolution
    // helpers the server uses, rather than re-deriving the org/repo slug
    // ourselves -- this can never drift from what the server actually wrote.
    // -----------------------------------------------------------------
    const { Database: BunDatabase } = await import('bun:sqlite');

    async function resolveWorkerOutputPath(sessionId: string, workerId: string): Promise<string> {
      const sqliteHandle = new BunDatabase(dbPath, { readonly: true });
      try {
        const row = sqliteHandle
          .query('SELECT data_scope, data_scope_slug FROM sessions WHERE id = ?')
          .get(sessionId) as { data_scope: string | null; data_scope_slug: string | null } | undefined;
        if (!row || !row.data_scope) bail(`session ${sessionId} has no data_scope row`);
        const baseDir = computeSessionDataBaseDir(disposableHome, row.data_scope as 'quick' | 'repository', row.data_scope_slug);
        const resolver = new SessionDataPathResolver(baseDir);
        return resolver.getOutputFilePath(sessionId, workerId);
      } finally {
        sqliteHandle.close();
      }
    }

    const outputPathD = await resolveWorkerOutputPath(sessionD.id, agentWorkerD.id);
    const outputPathT = await resolveWorkerOutputPath(sessionT.id, agentWorkerT.id);
    console.log(`==> D's worker output file: ${outputPathD}`);
    console.log(`==> T's worker output file: ${outputPathT}`);

    function readOutputFileSafe(p: string): string {
      try {
        return existsSync(p) ? readFileSync(p, 'utf-8') : '';
      } catch {
        return '';
      }
    }

    // D and T's agent-worker PTYs start a real login shell and only TYPE
    // the actual `claude` command into it asynchronously, once a
    // sentinel string echoed by shell startup is observed in the PTY's own
    // output (see worker-manager.ts's sentinel-spawn mechanism). Firing a
    // webhook notification (which itself types into the SAME PTY stdin)
    // before that sentinel-triggered injection has completed races with
    // it: the notification's bytes can land ahead of the auto-typed
    // `claude` command in the shell's input queue, corrupting the command
    // line and leaving a plain interactive shell behind instead of a
    // running `claude` TUI. Wait out that startup window up front so every
    // scenario below observes a stable, already-running `claude` process.
    // Measured empirically in this environment; not a documented contract.
    console.log('==> waiting for D/T PTY startup (sentinel-triggered claude command injection) to settle');
    await Bun.sleep(8_000);

    async function countNotificationRows(eventType: string, sessionIds: string[]): Promise<Record<string, number>> {
      const sqliteHandle = new BunDatabase(dbPath, { readonly: true });
      try {
        const counts: Record<string, number> = {};
        for (const sessionId of sessionIds) {
          const row = sqliteHandle
            .query('SELECT COUNT(*) as c FROM inbound_event_notifications WHERE event_type = ? AND session_id = ?')
            .get(eventType, sessionId) as { c: number };
          counts[sessionId] = row.c;
        }
        return counts;
      } finally {
        sqliteHandle.close();
      }
    }

    // ===================================================================
    // SCENARIO 1: positive control -- `issues` `closed` fans out via the
    // OLD per-session loop to every worktree session (D and T), never to
    // the `quick` delegate.
    // ===================================================================
    console.log('\n==> SCENARIO 1: issues/closed (positive control, unaffected by this PR)');
    const closedRes = await postWebhook(
      baseUrl,
      'issues',
      {
        action: 'closed',
        issue: { number: 1001, title: 'Scenario 1 closed issue', html_url: null, updated_at: null },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(closedRes.status === 200, 'SCENARIO 1: POST /webhooks/github returns 200', `status=${closedRes.status}`);
    await closedRes.text();

    const scenario1Found = await waitFor(async () => {
      const counts = await countNotificationRows('issue:closed', [sessionD.id, sessionT.id, delegateSession.id]);
      return counts[sessionD.id] > 0 && counts[sessionT.id] > 0;
    }, 10_000, 'issue:closed notification rows for D and T');
    const scenario1Counts = await countNotificationRows('issue:closed', [sessionD.id, sessionT.id, delegateSession.id]);
    expect(scenario1Found, 'SCENARIO 1: D and T both received issue:closed notifications', JSON.stringify(scenario1Counts));
    expect(scenario1Counts[delegateSession.id] === 0, 'SCENARIO 1: the quick delegate session received no issue:closed notification', JSON.stringify(scenario1Counts));

    // ===================================================================
    // SCENARIO 2: negative control -- a non-matching label.
    // ===================================================================
    console.log('\n==> SCENARIO 2: issues/labeled, non-matching label (negative control)');
    const beforeScenario2Counts = await countNotificationRows('issue:labeled', [sessionD.id, sessionT.id, delegateSession.id]);
    const labeledMismatchRes = await postWebhook(
      baseUrl,
      'issues',
      {
        action: 'labeled',
        label: { name: 'totally-unrelated-label' },
        issue: { number: 1002, title: 'Scenario 2 non-matching label', html_url: null, updated_at: null },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(labeledMismatchRes.status === 200, 'SCENARIO 2: POST /webhooks/github returns 200', `status=${labeledMismatchRes.status}`);
    await labeledMismatchRes.text();

    // No positive event to poll FOR here -- settle on a fixed generous
    // window, then check once (steady-state negative assertion).
    await Bun.sleep(2000);
    const afterScenario2Counts = await countNotificationRows('issue:labeled', [sessionD.id, sessionT.id, delegateSession.id]);
    expect(
      afterScenario2Counts[sessionD.id] === beforeScenario2Counts[sessionD.id] &&
        afterScenario2Counts[sessionT.id] === beforeScenario2Counts[sessionT.id] &&
        afterScenario2Counts[delegateSession.id] === beforeScenario2Counts[delegateSession.id],
      'SCENARIO 2: zero new issue:labeled notification rows for the non-matching label',
      `before=${JSON.stringify(beforeScenario2Counts)} after=${JSON.stringify(afterScenario2Counts)}`,
    );
    // Exact wording confirmed by reading resolve-targets.ts's
    // resolveIssueLabeledTargets log call directly (see this smoke's
    // registration entry in test-trigger.md for the citation).
    expect(
      stdoutBuf.includes("issue:labeled event did not match repository's configured trigger labels"),
      "SCENARIO 2: server stdout contains resolve-targets.ts's non-match log message",
      `stdout tail: ${stdoutBuf.slice(-2000)}`,
    );

    // ===================================================================
    // SCENARIO 3: matching label, `labeled` action -- D only.
    // ===================================================================
    console.log('\n==> SCENARIO 3: issues/labeled, matching label (D only)');
    const beforeD3 = readOutputFileSafe(outputPathD);
    const beforeT3 = readOutputFileSafe(outputPathT);
    const labeledMatchRes = await postWebhook(
      baseUrl,
      'issues',
      {
        action: 'labeled',
        label: { name: webhookTriggerLabel },
        issue: { number: 1003, title: 'Scenario 3 matching label', html_url: null, updated_at: null },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(labeledMatchRes.status === 200, 'SCENARIO 3: POST /webhooks/github returns 200', `status=${labeledMatchRes.status}`);
    await labeledMatchRes.text();

    // The generous timeout accounts for the real interactive `claude` CLI's
    // own cold-start latency inside the PTY (auth/session/MCP-config
    // checks) -- the notification's bytes are written to the PTY's stdin
    // immediately, but the TUI may not render (and therefore echo) them
    // into the captured output stream until it has finished initializing.
    // Measured empirically: an earlier 10s budget was too tight in this
    // environment.
    const scenario3TagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD3.length).includes('[inbound:issue:labeled]');
    }, 45_000, "D's output file to contain [inbound:issue:labeled]");
    expect(scenario3TagFound, 'SCENARIO 3: D received the [inbound:issue:labeled] PTY notification', readOutputFileSafe(outputPathD).slice(beforeD3.length).slice(-500));

    const afterT3 = readOutputFileSafe(outputPathT);
    expect(
      !afterT3.slice(beforeT3.length).includes('[inbound:issue:labeled]'),
      'SCENARIO 3: T did NOT receive the [inbound:issue:labeled] PTY notification',
      afterT3.slice(beforeT3.length).slice(-500),
    );
    const afterScenario3DelegateNotif = await countNotificationRows('issue:labeled', [delegateSession.id]);
    expect(
      afterScenario3DelegateNotif[delegateSession.id] === beforeScenario2Counts[delegateSession.id],
      'SCENARIO 3: the delegate session received no issue:labeled notification row',
      JSON.stringify(afterScenario3DelegateNotif),
    );

    // ===================================================================
    // SCENARIO 4: matching label, `opened` action (full label set) -- D only.
    // ===================================================================
    console.log('\n==> SCENARIO 4: issues/opened, full label set including the matching label (D only)');
    const beforeD4 = readOutputFileSafe(outputPathD);
    const beforeT4 = readOutputFileSafe(outputPathT);
    const openedRes = await postWebhook(
      baseUrl,
      'issues',
      {
        action: 'opened',
        issue: {
          number: 1004,
          title: 'Scenario 4 opened with full label set',
          html_url: null,
          updated_at: null,
          labels: [{ name: 'unrelated' }, { name: webhookTriggerLabel }],
        },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(openedRes.status === 200, 'SCENARIO 4: POST /webhooks/github returns 200', `status=${openedRes.status}`);
    await openedRes.text();

    const scenario4TagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD4.length).includes('[inbound:issue:labeled]');
    }, 45_000, "D's output file to contain [inbound:issue:labeled] (scenario 4)");
    expect(scenario4TagFound, 'SCENARIO 4: D received the [inbound:issue:labeled] PTY notification', readOutputFileSafe(outputPathD).slice(beforeD4.length).slice(-500));

    const afterT4 = readOutputFileSafe(outputPathT);
    expect(
      !afterT4.slice(beforeT4.length).includes('[inbound:issue:labeled]'),
      'SCENARIO 4: T did NOT receive the [inbound:issue:labeled] PTY notification',
      afterT4.slice(beforeT4.length).slice(-500),
    );
  } finally {
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
      console.log(`\n==> cleaned up scratch root: ${scratchRoot}`);
    } catch (err) {
      console.error(`==> WARNING: failed to clean up ${scratchRoot}: ${String(err)}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

// Guarded (Issue #1479): importing this module must not fire a run as a
// side effect. `import.meta.main` is false for an importer, true only when
// this file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof BailError) {
      console.error(`\nCOULD NOT RUN: ${err.message}`);
      process.exit(2);
    }
    console.error(`E2E FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  });
}
