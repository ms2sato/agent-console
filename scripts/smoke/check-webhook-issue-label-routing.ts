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
 *      pass). Routes exclusively to the repository's DESIGNATED SET -- D
 *      and D2, both designated via real `set_orchestrator_session` calls
 *      (Issue #1716: a Repository row holds a set of designated sessions,
 *      and delivery goes to every live one) -- confirmed by reading both
 *      D's and D2's real worker output files for the
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
 *      Same D-and-D2-not-T assertion shape as scenario 3, on a different
 *      issue number so the two are distinguishable if debugging is needed.
 *
 *   4b. POSITIVE (Issue #1716, hibernated designated session is SKIPPED,
 *      never auto-removed): D2 is PAUSED via `POST /:id/pause` (absent
 *      from the live session manager, DB row preserved) and the scenario 3
 *      shape is posted again. Only D receives; D2's output file and T's
 *      are unchanged; the server's own stdout contains the exact
 *      per-session skip reason `resolveIssueLabeledTargets` logs for a
 *      designated session that is not live (attribution, not silence);
 *      and `GET /api/repositories/:id` still lists D2 in
 *      `orchestratorSessionIds` -- routing skipped it, nothing removed it.
 *      D2 stays paused for scenarios 5-7, which therefore also exercise
 *      "a designated-but-not-live session is skipped by the fallback".
 *
 *   5. POSITIVE (Issue #1661, main-push fallback): a `workflow_run`
 *      `completed`/`success` event on `head_branch: 'main'`, matching zero
 *      registered sessions (neither D's nor T's worktreeId). Routes to D
 *      (the live designated Orchestrator session) via `resolveTargets`'s
 *      designated-session fallback -- confirmed by reading D's real worker
 *      output file for the `[inbound:ci:completed]` tag. T must NOT receive
 *      it, and neither must the paused D2 (designated, skipped). `head_sha` is omitted so `job-handler.ts`'s `ciCompletionChecker`
 *      gate never runs (it only fires when `commitSha` is present), avoiding
 *      a pointless real `gh api` call against a nonexistent repo.
 *
 *   6. POSITIVE (Issue #1661, dead-parent fallback): a third worktree
 *      session O is created with `parentSessionId` pointing at a real
 *      session P, which is then PAUSED via `POST /:id/pause` -- pausing
 *      removes P from the live session manager (`getAllSessions()`) while
 *      preserving its DB row, exactly matching `resolveTargets`'s "parent
 *      absent from getSessions()" shape without tripping a separate
 *      `job-handler.ts` defect a literal never-persisted UUID would trigger
 *      (see this scenario's own in-code comment for the full explanation --
 *      that defect is now fixed, Issue #1677, and scenario 7 below exercises
 *      it directly). The same `workflow_run` shape as scenario 5, but with
 *      `head_branch` matching O's worktreeId, routes to BOTH O (direct
 *      branch match) and D (fallback, since O's parent P is no longer live)
 *      -- confirmed by reading both O's and D's real worker output files.
 *      T must receive neither.
 *
 *   7. POSITIVE (Issue #1677, deleted-parent fallback + no job retry): a
 *      fourth worktree session Q is created with `parentSessionId` pointing
 *      at a real session R, which is then genuinely DELETED via
 *      `DELETE /api/sessions/:id` -- unlike scenario 6's pause, this removes
 *      R's row from the `sessions` table entirely, reproducing the exact
 *      FOREIGN KEY-constraint shape Issue #1677 fixed (a resolved target
 *      whose `sessionId` has no corresponding `sessions` row at all). The
 *      same `workflow_run` shape as scenarios 5-6, with `head_branch`
 *      matching Q's worktreeId, routes to BOTH Q (direct branch match) and D
 *      (fallback, since Q's parent R no longer exists) -- confirmed by
 *      reading both Q's and D's real worker output files; T must receive
 *      neither. This scenario additionally opens a read-only handle on the
 *      disposable server's own `jobs` table and asserts the job that
 *      processed this webhook has `status = 'completed'` and `attempts = 0`
 *      -- direct proof that Issue #1677's per-target failure isolation
 *      stopped this defect from crashing and retrying the whole job.
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
 *     `git worktree add` worktrees for D, D2, T, (scenario 6) O and P, and
 *     (scenario 7) Q and R, and real `getOrgRepoFromPath` remote-URL
 *     resolution (local-only, no network);
 *   - real sessions and real PTY-backed `agent` workers created via the
 *     real `POST /api/sessions` route (the default `claude-code-builtin`
 *     agent, spawned interactively with no prompt sent -- no LLM API call);
 *   - two real `set_orchestrator_session` MCP calls (D, then D2) over real
 *     `/mcp` JSON-RPC, and a real `GET /api/repositories/:id` read of the
 *     resulting designated set;
 *   - real `POST /:id/pause` calls (scenario 4b: D2; scenario 6: P) to
 *     remove a session from the live session manager while preserving its
 *     DB row;
 *   - a real `DELETE /api/sessions/:id` call (scenario 7) to remove session
 *     R's row from the `sessions` table entirely.
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
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-console-webhook-label-smoke-'));
  const disposableHome = path.join(scratchRoot, 'home');
  const repoDir = path.join(scratchRoot, 'repo');
  const worktreeDDir = path.join(scratchRoot, 'worktree-d');
  const worktreeD2Dir = path.join(scratchRoot, 'worktree-d2');
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
    git(['worktree', 'add', worktreeD2Dir, '-b', 'smoke-branch-d2'], repoDir);
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
    const claudeConfigPath = path.join(claudeConfigDir, '.claude.json');
    mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
    const realClaudeConfigPath = path.join(os.homedir(), '.claude.json');
    let baseClaudeConfig: Record<string, unknown> = {};
    try {
      baseClaudeConfig = JSON.parse(readFileSync(realClaudeConfigPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // No real ~/.claude.json (e.g. `claude` never run as this OS user) --
      // proceed with an empty base; the trust-dialog bypass below still
      // applies, though onboarding may then also appear.
    }
    let isolatedClaudeConfig: Record<string, unknown> = {
      ...baseClaudeConfig,
      projects: {
        ...(baseClaudeConfig.projects as Record<string, unknown> | undefined),
        [worktreeDDir]: { hasTrustDialogAccepted: true },
        [worktreeD2Dir]: { hasTrustDialogAccepted: true },
        [worktreeTDir]: { hasTrustDialogAccepted: true },
      },
    };

    /**
     * Merge one more pre-trusted project path into the in-memory config and
     * re-write it to disk. Extracted (Issue #1661, scenario 6) so a
     * worktree created AFTER the disposable server has already started
     * (session O, added for the dead-parent-fallback scenario) can still be
     * pre-trusted -- the config file is read by the `claude` CLI process at
     * its own PTY-spawn time, not just once at server bring-up, so
     * appending to the same on-disk file the running server's
     * `CLAUDE_CONFIG_DIR` already points at is sufficient; no server
     * restart is needed.
     */
    function addTrustedProject(projectPath: string): void {
      isolatedClaudeConfig = {
        ...isolatedClaudeConfig,
        projects: {
          ...(isolatedClaudeConfig.projects as Record<string, unknown> | undefined),
          [projectPath]: { hasTrustDialogAccepted: true },
        },
      };
      writeFileSync(claudeConfigPath, JSON.stringify(isolatedClaudeConfig), { mode: 0o600 });
    }

    // Initial write covering D, D2 and T.
    writeFileSync(claudeConfigPath, JSON.stringify(isolatedClaudeConfig), { mode: 0o600 });

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

    // `@agent-console/shared` is not resolvable as a bare specifier from a
    // root-level script (only workspace packages get a `node_modules/
    // @agent-console/shared` symlink from `bun install`) -- imported here by
    // its actual source path instead, same convention as the server-module
    // imports directly above (scenario 7's job-status assertions need the
    // real `JOB_TYPES` / `JOB_STATUS` constants, not re-typed string literals).
    const { JOB_TYPES, JOB_STATUS } = await import('../../packages/shared/src/types/job.ts');

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
    console.log('\n==> creating sessions D and D2 (both to be designated orchestrators) and T (plain worktree)');
    const sessionD = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-d',
      locationPath: worktreeDDir,
    });
    console.log(`==> session D created: ${sessionD.id} (workers: ${JSON.stringify(sessionD.workers.map((w) => w.type))})`);

    const sessionD2 = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-d2',
      locationPath: worktreeD2Dir,
    });
    console.log(`==> session D2 created: ${sessionD2.id} (workers: ${JSON.stringify(sessionD2.workers.map((w) => w.type))})`);

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
    const agentWorkerD2 = sessionD2.workers.find((w) => w.type === 'agent');
    const agentWorkerT = sessionT.workers.find((w) => w.type === 'agent');
    if (!agentWorkerD) bail('session D has no agent worker');
    if (!agentWorkerD2) bail('session D2 has no agent worker');
    if (!agentWorkerT) bail('session T has no agent worker');

    // -----------------------------------------------------------------
    // Designate D AND D2 as the repository's Orchestrators via real MCP
    // calls (Issue #1716: each call adds the calling session to the row's
    // designated SET; D2's add must leave D's designation in place).
    // -----------------------------------------------------------------
    console.log('\n==> designating D and D2 as repository Orchestrators via set_orchestrator_session');
    const mcpSessionId = await initializeMcp(baseUrl);
    const designateResultD = (await callMcpTool(baseUrl, mcpSessionId, 'set_orchestrator_session', {
      sessionId: sessionD.id,
    })) as { repositoryId: string; orchestratorSessionIds: string[] };
    expect(
      Array.isArray(designateResultD.orchestratorSessionIds) && designateResultD.orchestratorSessionIds.includes(sessionD.id),
      'set_orchestrator_session adds D to the designated set',
      JSON.stringify(designateResultD),
    );
    const designateResultD2 = (await callMcpTool(baseUrl, mcpSessionId, 'set_orchestrator_session', {
      sessionId: sessionD2.id,
    })) as { repositoryId: string; orchestratorSessionIds: string[] };
    expect(
      Array.isArray(designateResultD2.orchestratorSessionIds) &&
        designateResultD2.orchestratorSessionIds.includes(sessionD.id) &&
        designateResultD2.orchestratorSessionIds.includes(sessionD2.id) &&
        designateResultD2.orchestratorSessionIds.length === 2,
      "set_orchestrator_session adds D2 WITHOUT displacing D (set is exactly {D, D2})",
      JSON.stringify(designateResultD2),
    );

    /** Read the designated set back through the real REST route (the same row the routing reads). */
    async function readDesignatedSet(): Promise<string[]> {
      const res = await fetch(`${baseUrl}/api/repositories/${repository.id}`);
      if (!res.ok) bail(`GET /api/repositories/:id failed (status ${res.status}): ${await res.text()}`);
      const body = (await res.json()) as { repository: { orchestratorSessionIds: string[] } };
      return body.repository.orchestratorSessionIds;
    }

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
    const outputPathD2 = await resolveWorkerOutputPath(sessionD2.id, agentWorkerD2.id);
    const outputPathT = await resolveWorkerOutputPath(sessionT.id, agentWorkerT.id);
    console.log(`==> D's worker output file: ${outputPathD}`);
    console.log(`==> D2's worker output file: ${outputPathD2}`);
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
    console.log('==> waiting for D/D2/T PTY startup (sentinel-triggered claude command injection) to settle');
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
    // SCENARIO 3: matching label, `labeled` action -- D and D2 (the
    // designated set), never T.
    // ===================================================================
    console.log('\n==> SCENARIO 3: issues/labeled, matching label (D and D2, not T)');
    const beforeD3 = readOutputFileSafe(outputPathD);
    const beforeD23 = readOutputFileSafe(outputPathD2);
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

    const scenario3D2TagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD2);
      return content.slice(beforeD23.length).includes('[inbound:issue:labeled]');
    }, 45_000, "D2's output file to contain [inbound:issue:labeled]");
    expect(scenario3D2TagFound, 'SCENARIO 3: D2 (second designated session) ALSO received the [inbound:issue:labeled] PTY notification', readOutputFileSafe(outputPathD2).slice(beforeD23.length).slice(-500));

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
    // SCENARIO 4: matching label, `opened` action (full label set) -- D and
    // D2, never T.
    // ===================================================================
    console.log('\n==> SCENARIO 4: issues/opened, full label set including the matching label (D and D2, not T)');
    const beforeD4 = readOutputFileSafe(outputPathD);
    const beforeD24 = readOutputFileSafe(outputPathD2);
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

    const scenario4D2TagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD2);
      return content.slice(beforeD24.length).includes('[inbound:issue:labeled]');
    }, 45_000, "D2's output file to contain [inbound:issue:labeled] (scenario 4)");
    expect(scenario4D2TagFound, 'SCENARIO 4: D2 (second designated session) ALSO received the [inbound:issue:labeled] PTY notification', readOutputFileSafe(outputPathD2).slice(beforeD24.length).slice(-500));

    const afterT4 = readOutputFileSafe(outputPathT);
    expect(
      !afterT4.slice(beforeT4.length).includes('[inbound:issue:labeled]'),
      'SCENARIO 4: T did NOT receive the [inbound:issue:labeled] PTY notification',
      afterT4.slice(beforeT4.length).slice(-500),
    );

    // ===================================================================
    // SCENARIO 4b (Issue #1716): a designated session that is not live is
    // SKIPPED by routing and never auto-removed. Pause D2 (its DB row
    // survives; it leaves the live session manager, so
    // `resolveIssueLabeledTargets` finds no live session for that id), post
    // the scenario 3 shape again, and assert: D still receives, D2 and T
    // do not, the server logged the per-session skip reason for D2 (the
    // negative result is attributed to the code path, not to silence), and
    // the row STILL lists D2 as designated.
    // ===================================================================
    console.log('\n==> SCENARIO 4b: issues/labeled, matching label, with D2 PAUSED (D only; D2 skipped, still designated)');
    const pauseD2Res = await fetch(`${baseUrl}/api/sessions/${sessionD2.id}/pause`, { method: 'POST' });
    expect(pauseD2Res.status === 200, 'SCENARIO 4b: session D2 paused successfully (absent from the live session manager, DB row preserved)', `status=${pauseD2Res.status} body=${await pauseD2Res.text().catch(() => '')}`);

    const beforeD4b = readOutputFileSafe(outputPathD);
    const beforeD24b = readOutputFileSafe(outputPathD2);
    const beforeT4b = readOutputFileSafe(outputPathT);
    const stdoutLenBefore4b = stdoutBuf.length;
    const pausedRes = await postWebhook(
      baseUrl,
      'issues',
      {
        action: 'labeled',
        label: { name: webhookTriggerLabel },
        issue: { number: 1005, title: 'Scenario 4b matching label with D2 paused', html_url: null, updated_at: null },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(pausedRes.status === 200, 'SCENARIO 4b: POST /webhooks/github returns 200', `status=${pausedRes.status}`);
    await pausedRes.text();

    const scenario4bTagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD4b.length).includes('[inbound:issue:labeled]');
    }, 45_000, "D's output file to contain [inbound:issue:labeled] (scenario 4b)");
    expect(scenario4bTagFound, 'SCENARIO 4b: D (the live designated session) received the [inbound:issue:labeled] PTY notification', readOutputFileSafe(outputPathD).slice(beforeD4b.length).slice(-500));

    const afterD24b = readOutputFileSafe(outputPathD2);
    expect(
      !afterD24b.slice(beforeD24b.length).includes('[inbound:issue:labeled]'),
      'SCENARIO 4b: the paused D2 did NOT receive the [inbound:issue:labeled] PTY notification',
      afterD24b.slice(beforeD24b.length).slice(-500),
    );
    const afterT4b = readOutputFileSafe(outputPathT);
    expect(
      !afterT4b.slice(beforeT4b.length).includes('[inbound:issue:labeled]'),
      'SCENARIO 4b: T did NOT receive the [inbound:issue:labeled] PTY notification',
      afterT4b.slice(beforeT4b.length).slice(-500),
    );
    // Exact wording confirmed by reading resolve-targets.ts's per-session
    // skip log call directly (a paused session is absent from
    // `getSessions()`, so this is the "not a live session" reason, not the
    // "not running" one a hibernated-but-present session would produce).
    const stdoutSince4b = stdoutBuf.slice(stdoutLenBefore4b);
    expect(
      stdoutSince4b.includes('issue:labeled event matched repository but a designated orchestrator session is not a live session') &&
        stdoutSince4b.includes(sessionD2.id),
      "SCENARIO 4b: server stdout contains resolve-targets.ts's per-session 'not a live session' skip reason naming D2",
      `stdout tail: ${stdoutSince4b.slice(-2000)}`,
    );
    const designatedAfterPause = await readDesignatedSet();
    expect(
      designatedAfterPause.includes(sessionD2.id) && designatedAfterPause.includes(sessionD.id),
      'SCENARIO 4b: D2 is STILL in the designated set after being skipped (routing never auto-removes a designation)',
      JSON.stringify(designatedAfterPause),
    );

    // ===================================================================
    // SCENARIO 5 (Issue #1661): main-push fallback. A `workflow_run`
    // `completed`/`success` event on `head_branch: 'main'` matches zero
    // registered sessions (neither D's `smoke-branch-d` nor T's
    // `smoke-branch-t`) -- resolveTargets's designated-session fallback
    // routes it to D. `head_sha` is omitted so job-handler.ts's
    // `ciCompletionChecker` gate (only active when `commitSha` is present)
    // never runs, avoiding a pointless real `gh api` call.
    // ===================================================================
    console.log('\n==> SCENARIO 5: workflow_run/completed on main, zero matching sessions (designated-session fallback)');
    const beforeD5 = readOutputFileSafe(outputPathD);
    const beforeD25 = readOutputFileSafe(outputPathD2);
    const beforeT5 = readOutputFileSafe(outputPathT);
    const mainPushRes = await postWebhook(
      baseUrl,
      'workflow_run',
      {
        action: 'completed',
        workflow_run: {
          conclusion: 'success',
          name: 'Scenario 5 CI',
          html_url: null,
          head_branch: 'main',
          head_sha: null,
          updated_at: null,
        },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(mainPushRes.status === 200, 'SCENARIO 5: POST /webhooks/github returns 200', `status=${mainPushRes.status}`);
    await mainPushRes.text();

    const scenario5TagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD5.length).includes('[inbound:ci:completed]');
    }, 45_000, "D's output file to contain [inbound:ci:completed] (scenario 5)");
    expect(scenario5TagFound, 'SCENARIO 5: D received the [inbound:ci:completed] PTY notification (fallback)', readOutputFileSafe(outputPathD).slice(beforeD5.length).slice(-500));

    const afterT5 = readOutputFileSafe(outputPathT);
    expect(
      !afterT5.slice(beforeT5.length).includes('[inbound:ci:completed]'),
      'SCENARIO 5: T did NOT receive the [inbound:ci:completed] PTY notification',
      afterT5.slice(beforeT5.length).slice(-500),
    );
    const afterD25 = readOutputFileSafe(outputPathD2);
    expect(
      !afterD25.slice(beforeD25.length).includes('[inbound:ci:completed]'),
      'SCENARIO 5: the paused-but-still-designated D2 did NOT receive the fallback (skipped by the same per-session exclusion)',
      afterD25.slice(beforeD25.length).slice(-500),
    );

    // ===================================================================
    // SCENARIO 6 (Issue #1661): dead-parent fallback. A third worktree
    // session O is created whose `parentSessionId` points at a REAL session
    // (P) that is then PAUSED -- `POST /:id/pause` kills P's PTY workers,
    // persists its paused state, and REMOVES it from the in-memory session
    // manager (`session-pause-resume-service.ts`'s own header comment:
    // "Pause: kill PTY workers, persist paused state, remove from memory").
    // The net effect is exactly `resolveTargets`'s "parent not found in
    // getSessions()" shape (P is absent from `sessionManager.getAllSessions()`
    // after pausing, same as a session that was never created) WITHOUT the
    // DB row being deleted.
    //
    // This is deliberately NOT a literal syntactically-valid-but-never-
    // persisted UUID (e.g. all-zeros), which was the first design tried
    // here. That version reproduces a SEPARATE defect: when a resolved
    // target's `sessionId` has no corresponding row in the `sessions` table
    // at all, `job-handler.ts`'s
    // `notificationRepository.createPendingNotification()` used to throw an
    // uncaught `FOREIGN KEY constraint failed` (the table's `session_id`
    // column references `sessions(id)`), which crashed and retried the
    // WHOLE job (all targets, not just the missing one) until it stalled
    // after 5 attempts -- so the designated-session fallback target
    // (appended LAST in `resolveTargets`'s target array, after the direct
    // match and the unconditionally-pushed parent-id target) never got
    // processed at all. That defect has since been fixed (Issue #1677,
    // per-target failure isolation in `job-handler.ts`) and is now
    // exercised directly by scenario 7 below, which genuinely deletes its
    // parent session's row instead of routing around the crash. The paused-
    // session construction here still exists because it tests a DIFFERENT
    // shape than scenario 7: a parent whose DB row is intact but which is
    // absent from the live session manager (`getSessions()`) -- e.g. a
    // paused session -- rather than a parent with no DB row at all. Both
    // shapes hit the same "parent absent from getSessions()" branch in
    // `resolveTargets`, but only the genuinely-deleted-row shape used to
    // trip the FK crash, which is why two separate scenarios exist.
    // ===================================================================
    console.log('\n==> SCENARIO 6: workflow_run/completed matching session O, whose parent P was paused (dead-parent fallback)');
    const worktreePDir = path.join(scratchRoot, 'worktree-p');
    git(['worktree', 'add', worktreePDir, '-b', 'smoke-branch-p'], repoDir);
    addTrustedProject(worktreePDir);

    const sessionP = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-p',
      locationPath: worktreePDir,
    });
    console.log(`==> session P created (will be paused to simulate a dead parent): ${sessionP.id}`);

    const worktreeODir = path.join(scratchRoot, 'worktree-o');
    git(['worktree', 'add', worktreeODir, '-b', 'smoke-branch-o'], repoDir);
    addTrustedProject(worktreeODir);

    const sessionO = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-o',
      locationPath: worktreeODir,
      parentSessionId: sessionP.id,
    });
    console.log(`==> session O created: ${sessionO.id} (parentSessionId=${sessionP.id})`);
    const agentWorkerO = sessionO.workers.find((w) => w.type === 'agent');
    if (!agentWorkerO) bail('session O has no agent worker');
    const outputPathO = await resolveWorkerOutputPath(sessionO.id, agentWorkerO.id);
    console.log(`==> O's worker output file: ${outputPathO}`);

    const pauseRes = await fetch(`${baseUrl}/api/sessions/${sessionP.id}/pause`, { method: 'POST' });
    expect(pauseRes.status === 200, 'SCENARIO 6: session P paused successfully (now absent from the live session manager, DB row preserved)', `status=${pauseRes.status} body=${await pauseRes.text().catch(() => '')}`);

    // Same PTY-startup race as D/T above (see that comment for why this
    // wait exists at all), scoped to O since it was created well after
    // D/T's own window. A longer budget than D/T's 8s is used here: by the
    // time O is created, D, T, and the delegate's PTYs are already running
    // real `claude` processes, and O's own sentinel-triggered injection
    // measurably takes longer to settle under that additional load in this
    // environment (empirically, 8s was insufficient and raced the webhook
    // write against the still-in-flight `claude` command injection,
    // corrupting it into a plain shell prompt with no `claude` ever
    // started -- exactly the failure this wait exists to prevent).
    console.log('==> waiting for O PTY startup (sentinel-triggered claude command injection) to settle');
    await Bun.sleep(20_000);

    const beforeD6 = readOutputFileSafe(outputPathD);
    const beforeT6 = readOutputFileSafe(outputPathT);
    const beforeO6 = readOutputFileSafe(outputPathO);
    const deadParentRes = await postWebhook(
      baseUrl,
      'workflow_run',
      {
        action: 'completed',
        workflow_run: {
          conclusion: 'success',
          name: 'Scenario 6 CI',
          html_url: null,
          head_branch: 'smoke-branch-o',
          head_sha: null,
          updated_at: null,
        },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(deadParentRes.status === 200, 'SCENARIO 6: POST /webhooks/github returns 200', `status=${deadParentRes.status}`);
    await deadParentRes.text();

    const scenario6OTagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathO);
      return content.slice(beforeO6.length).includes('[inbound:ci:completed]');
    }, 45_000, "O's output file to contain [inbound:ci:completed] (scenario 6, direct match)");
    expect(scenario6OTagFound, 'SCENARIO 6: O received the [inbound:ci:completed] PTY notification (direct match)', readOutputFileSafe(outputPathO).slice(beforeO6.length).slice(-500));

    const scenario6DTagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD6.length).includes('[inbound:ci:completed]');
    }, 45_000, "D's output file to contain [inbound:ci:completed] (scenario 6, dead-parent fallback)");
    expect(scenario6DTagFound, 'SCENARIO 6: D received the [inbound:ci:completed] PTY notification (fallback, O\'s parent P is paused/not live)', readOutputFileSafe(outputPathD).slice(beforeD6.length).slice(-500));

    const afterT6 = readOutputFileSafe(outputPathT);
    expect(
      !afterT6.slice(beforeT6.length).includes('[inbound:ci:completed]'),
      'SCENARIO 6: T did NOT receive the [inbound:ci:completed] PTY notification',
      afterT6.slice(beforeT6.length).slice(-500),
    );

    // ===================================================================
    // SCENARIO 7 (Issue #1677): deleted-parent fallback + no job retry. A
    // fourth worktree session Q is created whose `parentSessionId` points at
    // a REAL session (R) that is then genuinely DELETED via
    // `DELETE /api/sessions/:id` -- unlike scenario 6's pause, this removes
    // R's row from the `sessions` table entirely. `resolveTargets`
    // unconditionally pushes `{ sessionId: session.parentSessionId }` for
    // the fallback target regardless of whether that row still exists, so
    // this reproduces the exact shape `job-handler.ts`'s
    // `notificationRepository.createPendingNotification()` used to crash on
    // with an uncaught `FOREIGN KEY constraint failed` (Issue #1677, fixed
    // by wrapping each target/handler unit of work in its own try/catch so
    // one dangling target no longer fails -- and job-level-retries -- the
    // whole job).
    // ===================================================================
    console.log('\n==> SCENARIO 7: workflow_run/completed matching session Q, whose parent R was DELETED (deleted-parent fallback, no job retry)');
    const worktreeRDir = path.join(scratchRoot, 'worktree-r');
    git(['worktree', 'add', worktreeRDir, '-b', 'smoke-branch-r'], repoDir);
    addTrustedProject(worktreeRDir);

    const sessionR = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-r',
      locationPath: worktreeRDir,
    });
    console.log(`==> session R created (will be DELETED to simulate a dead parent with no DB row): ${sessionR.id}`);

    const worktreeQDir = path.join(scratchRoot, 'worktree-q');
    git(['worktree', 'add', worktreeQDir, '-b', 'smoke-branch-q'], repoDir);
    addTrustedProject(worktreeQDir);

    const sessionQ = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-q',
      locationPath: worktreeQDir,
      parentSessionId: sessionR.id,
    });
    console.log(`==> session Q created: ${sessionQ.id} (parentSessionId=${sessionR.id})`);
    const agentWorkerQ = sessionQ.workers.find((w) => w.type === 'agent');
    if (!agentWorkerQ) bail('session Q has no agent worker');
    const outputPathQ = await resolveWorkerOutputPath(sessionQ.id, agentWorkerQ.id);
    console.log(`==> Q's worker output file: ${outputPathQ}`);

    const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionR.id}`, { method: 'DELETE' });
    expect(deleteRes.status === 200, 'SCENARIO 7: session R deleted successfully (row removed from sessions table entirely)', `status=${deleteRes.status} body=${await deleteRes.text().catch(() => '')}`);

    // Same PTY-startup race as O above (see scenario 6's comment for why
    // this wait exists at all), scoped to Q since it was created well after
    // D/T/O's own windows and under the same additional load.
    console.log('==> waiting for Q PTY startup (sentinel-triggered claude command injection) to settle');
    await Bun.sleep(20_000);

    const beforeD7 = readOutputFileSafe(outputPathD);
    const beforeT7 = readOutputFileSafe(outputPathT);
    const beforeQ7 = readOutputFileSafe(outputPathQ);
    const deletedParentRes = await postWebhook(
      baseUrl,
      'workflow_run',
      {
        action: 'completed',
        workflow_run: {
          conclusion: 'success',
          name: 'Scenario 7 CI',
          html_url: null,
          head_branch: 'smoke-branch-q',
          head_sha: null,
          updated_at: null,
        },
        repository: { full_name: `${nonceOrg}/${nonceRepo}` },
      },
      webhookSecret,
    );
    expect(deletedParentRes.status === 200, 'SCENARIO 7: POST /webhooks/github returns 200', `status=${deletedParentRes.status}`);
    await deletedParentRes.text();

    const scenario7QTagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathQ);
      return content.slice(beforeQ7.length).includes('[inbound:ci:completed]');
    }, 45_000, "Q's output file to contain [inbound:ci:completed] (scenario 7, direct match)");
    expect(scenario7QTagFound, 'SCENARIO 7: Q received the [inbound:ci:completed] PTY notification (direct match)', readOutputFileSafe(outputPathQ).slice(beforeQ7.length).slice(-500));

    const scenario7DTagFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathD);
      return content.slice(beforeD7.length).includes('[inbound:ci:completed]');
    }, 45_000, "D's output file to contain [inbound:ci:completed] (scenario 7, deleted-parent fallback)");
    expect(scenario7DTagFound, 'SCENARIO 7: D received the [inbound:ci:completed] PTY notification (fallback, Q\'s parent R no longer exists)', readOutputFileSafe(outputPathD).slice(beforeD7.length).slice(-500));

    const afterT7 = readOutputFileSafe(outputPathT);
    expect(
      !afterT7.slice(beforeT7.length).includes('[inbound:ci:completed]'),
      'SCENARIO 7: T did NOT receive the [inbound:ci:completed] PTY notification',
      afterT7.slice(beforeT7.length).slice(-500),
    );

    // The actual point of scenario 7: prove the job that processed this
    // webhook completed on its FIRST attempt, with no job-level retry.
    // Before Issue #1677's fix, the dangling target's FK-constraint crash
    // would have thrown out of the whole job, and the job queue would have
    // scheduled a retry (incrementing `attempts`) up to `max_attempts`
    // times. Reads the disposable server's own `jobs` table directly --
    // this is the LAST scenario to post a webhook, so "most recently
    // created inbound-event:process job" unambiguously identifies this
    // scenario's own job.
    //
    // WARNING FOR WHOEVER ADDS SCENARIO 8: this "most recent job of this
    // type" query is correct ONLY because scenario 7 is currently the LAST
    // scenario in this file to post a webhook. If a scenario 8 is added
    // AFTER this point, this query will silently pick up scenario 8's job
    // instead of scenario 7's, and this assertion will start measuring the
    // wrong job with no error -- a false pass, not a loud failure. Before
    // adding scenario 8, either (a) move this whole job-status assertion
    // block to run immediately after scenario 8 instead, or (b) scope the
    // query more precisely (e.g. embed a per-scenario marker in the webhook
    // payload and match on it, or record the job id from the enqueue
    // response instead of inferring "most recent").
    const jobsHandle = new BunDatabase(dbPath, { readonly: true });
    let scenario7Job: { status: string; attempts: number } | undefined;
    try {
      scenario7Job = jobsHandle
        .query('SELECT status, attempts FROM jobs WHERE type = ? ORDER BY created_at DESC LIMIT 1')
        .get(JOB_TYPES.INBOUND_EVENT_PROCESS) as { status: string; attempts: number } | undefined;
    } finally {
      jobsHandle.close();
    }
    expect(scenario7Job !== undefined, 'SCENARIO 7: an inbound-event:process job row exists', JSON.stringify(scenario7Job));
    expect(scenario7Job?.status === JOB_STATUS.COMPLETED, 'SCENARIO 7: the job completed (status=completed)', JSON.stringify(scenario7Job));
    expect(scenario7Job?.attempts === 0, 'SCENARIO 7: the job completed on its first attempt (attempts=0, no job-level retry)', JSON.stringify(scenario7Job));
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
