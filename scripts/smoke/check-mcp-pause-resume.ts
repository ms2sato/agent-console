#!/usr/bin/env bun
/**
 * Shipping-path E2E for the `pause_session` / `resume_session` MCP tools
 * (Issue #2315): real `/mcp` JSON-RPC calls against a real disposable
 * server, driving the real `SessionManager.pauseSession` /
 * `SessionManager.resumeSession` through the real authorization gate
 * (`checkCallerOwnsSession` + `checkPauseResumeRelationship`).
 *
 * FREE AND DETERMINISTIC -- no `claude` CLI turn, no provider key, no LLM
 * call anywhere in this path. Every PTY this script spawns (parent P,
 * child C, unrelated U) is a real interactive `claude-code-builtin` shell
 * with no prompt ever sent (the trust-dialog bypass below is needed only
 * because a real PTY is spawned at all, not because a turn runs on it).
 *
 * Modeled on `check-webhook-issue-label-routing.ts`: a real disposable
 * server booted as a REAL CHILD PROCESS (not an in-process `import()`),
 * a real disposable git repository with real `git worktree add`
 * worktrees, an isolated `CLAUDE_CONFIG_DIR` trust-dialog bypass, and real
 * `/mcp` JSON-RPC calls over plain `fetch` against that child process --
 * never the in-process `callTool` test helper.
 *
 * ============================================================================
 * WHAT THIS SCRIPT VERIFIES (one run, in order)
 * ============================================================================
 *
 *   1. `pause_session` called from U (unrelated) targeting C is refused;
 *      C stays live (positive control: `get_session_status` on C still
 *      shows a worker).
 *   2. `pause_session` called from P (C's parent) targeting C returns
 *      `changed: true`; C's `sessions` row has `paused_at` set and
 *      `server_pid` NULL (direct read-only SQLite read); `list_sessions`
 *      without `includePaused` no longer lists C; `list_sessions` with
 *      `includePaused: true` lists C with `pausedAt` present.
 *   3. `send_session_message` from P to the now-paused C succeeds, and
 *      exactly one new `deferred_worker_notifications` row exists for C
 *      (baseline-relative, scoped by session and worker id).
 *   4. `resume_session` called from U targeting C is refused; C's row is
 *      still paused (unchanged).
 *   5. `resume_session` called from P targeting C returns `changed: true`;
 *      C's row now has `paused_at` NULL; C's worker output file gains the
 *      paused-digest notification text (matched on the `[internal:paused-
 *      digest]` tag specifically, never "the file grew" -- see the
 *      baseline-stability wait below, which guards against the exact
 *      false-failure mode `smoke-verification-server.md`'s Scenario 4b
 *      entry documents: a late flush of an EARLIER write landing after a
 *      naively-taken baseline).
 *   6. A second `resume_session` call from P returns `changed: false` (C
 *      is already active; `sessionManager.resumeSession` is not called a
 *      second time -- the tool's own idempotency check, not a race).
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 *
 *   - a real disposable server process (`bun packages/server/src/index.ts`),
 *     booted exactly as `bun run dev` would, under a disposable
 *     `AGENT_CONSOLE_HOME`;
 *   - a real disposable git repository with real `git worktree add`
 *     worktrees for P, C and U;
 *   - real sessions and real PTY-backed `agent` workers created via the
 *     real `POST /api/sessions` route (the default `claude-code-builtin`
 *     agent, spawned interactively with no prompt ever sent -- no LLM API
 *     call, no cost);
 *   - real `/mcp` JSON-RPC calls (`pause_session`, `resume_session`,
 *     `send_session_message`, `list_sessions`, `get_session_status`)
 *     against the real running server, driving the real
 *     `checkCallerOwnsSession` + `checkPauseResumeRelationship` gate and
 *     the real `SessionManager.pauseSession` / `.resumeSession`;
 *   - direct read-only SQLite reads of the disposable server's own
 *     database file for `sessions.paused_at` / `sessions.server_pid` and
 *     `deferred_worker_notifications` row counts.
 *
 * Usage:
 *   NODE_ENV=development bun scripts/smoke/check-mcp-pause-resume.ts
 *   (NODE_ENV must be set explicitly; the smoke refuses to guess.)
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (a real regression)
 *   2  bad usage / the smoke could not run (server failed to boot, git
 *      commands failed, etc.)
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createScratchGitRepo, type ScratchGitRepo } from '../../packages/server/src/__tests__/utils/scratch-git.js';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Mini assertion harness -- same shape as this repo's other server-story
// smokes (e.g. `check-webhook-issue-label-routing.ts`).
// ---------------------------------------------------------------------------
const failures: string[] = [];
let passes = 0;

// Captured server stdout/stderr -- 'ignore' by default would leave a
// SCENARIO 5 digest failure undiagnosable (was the flush never run, did the
// readiness gate cap out, or did delivery fail?). Populated by two
// fire-and-forget read loops started right after the server is spawned; see
// `check-webhook-issue-label-routing.ts`'s identical pattern.
let stdoutBuf = '';
let stderrBuf = '';

// Set when SCENARIO 5's digest-appearance assertion fails, so the teardown
// block below can keep the scratch root on disk for inspection instead of
// deleting it.
let scenario5DigestFailed = false;

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
  const { port } = s;
  s.stop(true);
  if (port === undefined) bail('Bun.serve() with port: 0 unexpectedly returned no port');
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

// Set once `main()` creates the scratch git repository; every `git()` call
// below runs against it, so its hermetic env (scratch-git.ts) applies
// uniformly instead of each call re-deriving cwd/env by hand.
let scratchRepo: ScratchGitRepo | undefined;

/** Run a git command against the scratch repository; bail loudly on a non-zero exit or an unexpected cwd. */
async function git(args: string[], cwd: string): Promise<void> {
  if (!scratchRepo) bail('git() called before the scratch repository was created');
  if (path.resolve(cwd) !== path.resolve(scratchRepo.dir)) {
    bail(`git() called with an unexpected cwd (expected the scratch repo dir ${scratchRepo.dir}, got ${cwd})`);
  }
  try {
    await scratchRepo.git(args);
  } catch (err) {
    bail(`git ${args.join(' ')} (cwd=${cwd}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers -- real HTTP against the disposable server's own
// /mcp endpoint, same pattern as `check-webhook-issue-label-routing.ts`.
// ---------------------------------------------------------------------------
async function initializeMcp(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-pause-resume-smoke', version: '1.0.0' } },
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

interface McpToolResult {
  isError: boolean;
  data: unknown;
}

/** Call an MCP tool and return BOTH the parsed JSON body and whether it was an error result -- never bail on an error, since several scenarios here expect one. */
async function callMcpTool(baseUrl: string, mcpSessionId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
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
  if (!text) bail(`MCP tool ${name} returned no text content: ${JSON.stringify(json)}`);
  return { isError: json.result?.isError === true, data: JSON.parse(text) };
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

function readOutputFileSafe(p: string): string {
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  // NODE_ENV-sensitive (Issue #1289), same reasoning as
  // `check-webhook-issue-label-routing.ts`: this smoke boots the real
  // `packages/server/src/index.ts` as a child process inheriting the
  // parent's `NODE_ENV` via `...process.env`. `index.ts`'s static-file-
  // serving branch (gated on NODE_ENV === 'production') requires a built
  // `public/index.html` that does not exist on an unbuilt dev tree.
  // Listed in `NODE_ENV_SENSITIVE_SMOKES`
  // (scripts/smoke/__tests__/node-env-discipline.test.ts).
  if (!process.env.NODE_ENV) {
    console.error(
      'check-mcp-pause-resume.ts: NODE_ENV must be set explicitly (production|development|test) -- this smoke boots the real server child process, whose static-file-serving branch depends on it; refusing to guess.',
    );
    process.exit(2);
  }

  process.chdir(REPO_ROOT);

  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-console-mcp-pause-resume-smoke-'));
  const disposableHome = path.join(scratchRoot, 'home');
  const worktreePDir = path.join(scratchRoot, 'worktree-p');
  const worktreeCDir = path.join(scratchRoot, 'worktree-c');
  const worktreeUDir = path.join(scratchRoot, 'worktree-u');
  mkdirSync(disposableHome, { recursive: true });
  console.log(`==> scratch root: ${scratchRoot}`);

  const port = getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let proc: ReturnType<typeof Bun.spawn> | undefined;

  try {
    // -----------------------------------------------------------------
    // Disposable git repository + three worktrees: P (parent), C (its
    // child delegate), U (unrelated worktree, the refusal caller).
    // -----------------------------------------------------------------
    console.log('==> setting up disposable git repository');
    scratchRepo = await createScratchGitRepo({ parentDir: scratchRoot, name: 'repo-' });
    const repoDir = scratchRepo.dir;
    await git(['worktree', 'add', worktreePDir, '-b', 'smoke-branch-p'], repoDir);
    await git(['worktree', 'add', worktreeCDir, '-b', 'smoke-branch-c'], repoDir);
    await git(['worktree', 'add', worktreeUDir, '-b', 'smoke-branch-u'], repoDir);

    // -----------------------------------------------------------------
    // Real interactive `claude` CLI trust-dialog bypass (see
    // `check-webhook-issue-label-routing.ts`'s header comment for the full
    // rationale -- a from-scratch config triggers the onboarding wizard
    // instead of the trust prompt, an equally-blocking dead end).
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
      // No real ~/.claude.json -- proceed with an empty base.
    }
    const isolatedClaudeConfig: Record<string, unknown> = {
      ...baseClaudeConfig,
      projects: {
        ...(baseClaudeConfig.projects as Record<string, unknown> | undefined),
        [worktreePDir]: { hasTrustDialogAccepted: true },
        [worktreeCDir]: { hasTrustDialogAccepted: true },
        [worktreeUDir]: { hasTrustDialogAccepted: true },
      },
    };
    writeFileSync(claudeConfigPath, JSON.stringify(isolatedClaudeConfig), { mode: 0o600 });

    // -----------------------------------------------------------------
    // Server bring-up: real child process.
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
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Fire-and-forget: drain both streams into buffers for the whole run's
    // lifetime, so a SCENARIO 5 diagnostic dump can grep the server's own
    // log lines after the fact. Mirrors `check-webhook-issue-label-routing.ts`.
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of proc!.stdout as ReadableStream<Uint8Array>) {
        stdoutBuf += decoder.decode(chunk);
      }
    })();
    void (async () => {
      for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) {
        stderrBuf += decoder.decode(chunk);
      }
    })();

    await waitForServerReady(baseUrl);
    console.log('==> disposable server is ready');

    process.env.AGENT_CONSOLE_HOME = disposableHome;
    const configModule = await import('../../packages/server/src/lib/config.ts');
    const { computeSessionDataBaseDir } = await import('../../packages/server/src/lib/session-data-path.ts');
    const { SessionDataPathResolver } = await import('../../packages/server/src/lib/session-data-path-resolver.ts');
    const { WORKER_OUTPUT_FLUSH_INTERVAL } = (await import('../../packages/server/src/lib/server-config.ts')).serverConfig;
    const dbPath = configModule.getDbPath();
    const { Database: BunDatabase } = await import('bun:sqlite');

    // -----------------------------------------------------------------
    // Repository registration + sessions P, C (child of P), U.
    // -----------------------------------------------------------------
    console.log('\n==> registering repository');
    const registerRes = await fetch(`${baseUrl}/api/repositories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoDir, description: 'mcp-pause-resume smoke' }),
    });
    if (!registerRes.ok) bail(`Repository registration failed (status ${registerRes.status}): ${await registerRes.text()}`);
    const { repository } = (await registerRes.json()) as { repository: { id: string } };
    console.log(`==> repository registered: ${repository.id}`);

    console.log('\n==> creating sessions P (parent), C (child delegate of P), U (unrelated)');
    const sessionP = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-p',
      locationPath: worktreePDir,
    });
    console.log(`==> session P created: ${sessionP.id}`);

    const sessionC = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-c',
      locationPath: worktreeCDir,
      parentSessionId: sessionP.id,
    });
    console.log(`==> session C created: ${sessionC.id} (parentSessionId=${sessionP.id})`);

    const sessionU = await createSession(baseUrl, {
      type: 'worktree',
      repositoryId: repository.id,
      worktreeId: 'smoke-branch-u',
      locationPath: worktreeUDir,
    });
    console.log(`==> session U created: ${sessionU.id} (unrelated)`);

    const agentWorkerC = sessionC.workers.find((w) => w.type === 'agent');
    if (!agentWorkerC) bail('session C has no agent worker');

    const mcpSessionId = await initializeMcp(baseUrl);

    // Worker output file path for C, derived the same way the webhook
    // smoke does: read `data_scope`/`data_scope_slug` from the disposable
    // server's own SQLite file and feed them into the same pure
    // path-resolution helpers the server uses, so this can never drift
    // from what the server actually wrote.
    async function resolveWorkerOutputPath(sessionId: string, workerId: string): Promise<string> {
      const sqliteHandle = new BunDatabase(dbPath, { readonly: true });
      try {
        const row = sqliteHandle
          .query('SELECT data_scope, data_scope_slug FROM sessions WHERE id = ?')
          .get(sessionId) as { data_scope: string | null; data_scope_slug: string | null } | undefined;
        if (!row || !row.data_scope) bail(`session ${sessionId} has no data_scope row`);
        const baseDir = computeSessionDataBaseDir(disposableHome, row.data_scope as 'quick' | 'repository', row.data_scope_slug);
        const resolver = new SessionDataPathResolver(baseDir, disposableHome);
        return resolver.getOutputFilePath(sessionId, workerId);
      } finally {
        sqliteHandle.close();
      }
    }
    const outputPathC = await resolveWorkerOutputPath(sessionC.id, agentWorkerC.id);
    console.log(`==> C's worker output file: ${outputPathC}`);

    function readSessionRow(sessionId: string): { paused_at: string | null; server_pid: number | null } {
      const sqliteHandle = new BunDatabase(dbPath, { readonly: true });
      try {
        const row = sqliteHandle
          .query('SELECT paused_at, server_pid FROM sessions WHERE id = ?')
          .get(sessionId) as { paused_at: string | null; server_pid: number | null } | undefined;
        if (!row) bail(`session ${sessionId} has no row in the sessions table`);
        return row;
      } finally {
        sqliteHandle.close();
      }
    }

    function countDeferredRows(sessionId: string, workerId: string): number {
      const sqliteHandle = new BunDatabase(dbPath, { readonly: true });
      try {
        const row = sqliteHandle
          .query('SELECT COUNT(*) as c FROM deferred_worker_notifications WHERE session_id = ? AND worker_id = ?')
          .get(sessionId, workerId) as { c: number };
        return row.c;
      } finally {
        sqliteHandle.close();
      }
    }

    // C's agent-worker PTY starts a real login shell and only TYPES the
    // actual `claude` command into it asynchronously, once a sentinel
    // string echoed by shell startup is observed (worker-manager.ts's
    // sentinel-spawn mechanism). Wait out that startup window up front, as
    // the webhook smoke does, so the later pause observes a stable,
    // already-running `claude` process rather than racing its own startup
    // injection (pausing kills the PTY either way, but a stable baseline
    // makes the rest of this run's timing assumptions hold).
    console.log('==> waiting for C/P/U PTY startup (sentinel-triggered claude command injection) to settle');
    await Bun.sleep(8_000);

    // ===================================================================
    // SCENARIO 1: pause_session from U (unrelated) on C is refused; C
    // stays live.
    // ===================================================================
    console.log('\n==> SCENARIO 1: pause_session from U (unrelated) on C is refused');
    const pauseByURes = await callMcpTool(baseUrl, mcpSessionId, 'pause_session', {
      sessionId: sessionC.id,
      fromSessionId: sessionU.id,
    });
    expect(pauseByURes.isError, 'SCENARIO 1: pause_session from U on C is refused (isError)', JSON.stringify(pauseByURes.data));

    const statusAfterRefusal = await callMcpTool(baseUrl, mcpSessionId, 'get_session_status', { sessionId: sessionC.id });
    expect(
      !statusAfterRefusal.isError,
      'SCENARIO 1 (positive control): get_session_status on C still succeeds (C is live)',
      JSON.stringify(statusAfterRefusal.data),
    );
    const statusAfterRefusalData = statusAfterRefusal.data as { paused?: boolean; workers?: unknown[] };
    expect(
      statusAfterRefusalData.paused === false && Array.isArray(statusAfterRefusalData.workers) && statusAfterRefusalData.workers.length > 0,
      'SCENARIO 1 (positive control): C reports paused:false with at least one worker',
      JSON.stringify(statusAfterRefusalData),
    );

    // ===================================================================
    // SCENARIO 2: pause_session from P (C's parent) on C succeeds.
    // ===================================================================
    console.log('\n==> SCENARIO 2: pause_session from P (C\'s parent) on C succeeds');
    const pauseByPRes = await callMcpTool(baseUrl, mcpSessionId, 'pause_session', {
      sessionId: sessionC.id,
      fromSessionId: sessionP.id,
    });
    expect(!pauseByPRes.isError, 'SCENARIO 2: pause_session from P on C succeeds', JSON.stringify(pauseByPRes.data));
    const pauseByPData = pauseByPRes.data as { changed?: boolean; state?: string; pausedAt?: string };
    expect(pauseByPData.changed === true, 'SCENARIO 2: pause_session reports changed:true', JSON.stringify(pauseByPData));
    expect(pauseByPData.state === 'paused', 'SCENARIO 2: pause_session reports state:paused', JSON.stringify(pauseByPData));

    const rowAfterPause = readSessionRow(sessionC.id);
    expect(rowAfterPause.paused_at !== null, 'SCENARIO 2: C\'s row has paused_at set', JSON.stringify(rowAfterPause));
    expect(rowAfterPause.server_pid === null, 'SCENARIO 2: C\'s row has server_pid NULL', JSON.stringify(rowAfterPause));

    const listWithoutFlag = await callMcpTool(baseUrl, mcpSessionId, 'list_sessions', {});
    const listWithoutFlagData = listWithoutFlag.data as { sessions: Array<{ id: string }> };
    expect(
      !listWithoutFlagData.sessions.some((s) => s.id === sessionC.id),
      'SCENARIO 2: list_sessions without includePaused no longer lists C',
      JSON.stringify(listWithoutFlagData.sessions.map((s) => s.id)),
    );

    const listWithFlag = await callMcpTool(baseUrl, mcpSessionId, 'list_sessions', { includePaused: true });
    const listWithFlagData = listWithFlag.data as { sessions: Array<{ id: string; paused?: boolean; pausedAt?: string }> };
    const cInPausedList = listWithFlagData.sessions.find((s) => s.id === sessionC.id);
    expect(cInPausedList !== undefined && cInPausedList.paused === true && !!cInPausedList.pausedAt,
      'SCENARIO 2: list_sessions with includePaused:true lists C with paused:true and pausedAt present',
      JSON.stringify(cInPausedList));

    // ===================================================================
    // SCENARIO 3: send_session_message from P to the paused C succeeds
    // and defers exactly one new row.
    // ===================================================================
    console.log('\n==> SCENARIO 3: send_session_message from P to paused C defers exactly one row');
    const deferredBefore = countDeferredRows(sessionC.id, agentWorkerC.id);
    const sendRes = await callMcpTool(baseUrl, mcpSessionId, 'send_session_message', {
      toSessionId: sessionC.id,
      content: 'hello from P, while you are paused',
      fromSessionId: sessionP.id,
    });
    expect(!sendRes.isError, 'SCENARIO 3: send_session_message to paused C succeeds', JSON.stringify(sendRes.data));
    const deferredAfter = countDeferredRows(sessionC.id, agentWorkerC.id);
    expect(deferredAfter === deferredBefore + 1, 'SCENARIO 3: exactly one new deferred_worker_notifications row for C', `before=${deferredBefore} after=${deferredAfter}`);

    // ===================================================================
    // SCENARIO 4: resume_session from U (unrelated) on C is refused; C's
    // row is still paused.
    // ===================================================================
    console.log('\n==> SCENARIO 4: resume_session from U (unrelated) on C is refused');
    const resumeByURes = await callMcpTool(baseUrl, mcpSessionId, 'resume_session', {
      sessionId: sessionC.id,
      fromSessionId: sessionU.id,
    });
    expect(resumeByURes.isError, 'SCENARIO 4: resume_session from U on C is refused (isError)', JSON.stringify(resumeByURes.data));
    const rowAfterRefusedResume = readSessionRow(sessionC.id);
    expect(rowAfterRefusedResume.paused_at !== null, 'SCENARIO 4: C\'s row is still paused (unchanged) after the refused resume', JSON.stringify(rowAfterRefusedResume));

    // ===================================================================
    // SCENARIO 5: resume_session from P on C succeeds; C's row clears
    // paused_at; C's worker output file gains the paused-digest text.
    //
    // Baseline-stability wait (per this smoke's own header comment and
    // `smoke-verification-server.md`'s Scenario 4b entry): wait longer
    // than WORKER_OUTPUT_FLUSH_INTERVAL since the pause's own kill (the
    // last known write to this file), then read the file twice with a
    // short gap and confirm the size is stable across both reads, so a
    // late flush of the PAUSE's own PTY-kill exit-time output cannot be
    // mistaken for the RESUME's digest.
    // ===================================================================
    console.log("\n==> SCENARIO 5: resume_session from P on C succeeds; C's output gains the paused-digest text");
    await Bun.sleep(WORKER_OUTPUT_FLUSH_INTERVAL * 3 + 500);
    let baselineOutputC = readOutputFileSafe(outputPathC);
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(WORKER_OUTPUT_FLUSH_INTERVAL + 50);
      const secondRead = readOutputFileSafe(outputPathC);
      if (secondRead.length === baselineOutputC.length) break;
      baselineOutputC = secondRead;
      if (i === 9) bail("C's output file never stabilized before the baseline could be taken (SCENARIO 5)");
    }
    console.log(`==> baseline output length for C: ${baselineOutputC.length} bytes (stable)`);

    // Baseline for the diagnostic dump below: only stdout produced BY this
    // resume (and the flush it triggers) should be inspected on failure.
    const stdoutLenBeforeScenario5 = stdoutBuf.length;

    const resumeByPRes = await callMcpTool(baseUrl, mcpSessionId, 'resume_session', {
      sessionId: sessionC.id,
      fromSessionId: sessionP.id,
    });
    expect(!resumeByPRes.isError, 'SCENARIO 5: resume_session from P on C succeeds', JSON.stringify(resumeByPRes.data));
    const resumeByPData = resumeByPRes.data as { changed?: boolean; state?: string };
    expect(resumeByPData.changed === true, 'SCENARIO 5: resume_session reports changed:true', JSON.stringify(resumeByPData));
    expect(resumeByPData.state === 'active', 'SCENARIO 5: resume_session reports state:active', JSON.stringify(resumeByPData));

    const rowAfterResume = readSessionRow(sessionC.id);
    expect(rowAfterResume.paused_at === null, 'SCENARIO 5: C\'s row has paused_at NULL after resume', JSON.stringify(rowAfterResume));

    // The digest is delivered only after `SessionManager.waitForWorkerReady`
    // resolves for the revived PTY worker, which has its own cap at
    // `WORKER_READY_CAP_MS` (60s) if the agent-agnostic output-quiet
    // heuristic never settles (e.g. `claude --resume` against a
    // conversation id with no actual local history, in this environment).
    // Wait comfortably past that cap rather than guessing a shorter bound.
    const digestFound = await waitFor(() => {
      const content = readOutputFileSafe(outputPathC);
      return content.slice(baselineOutputC.length).includes('[internal:paused-digest]');
    }, 75_000, "C's output file gaining the [internal:paused-digest] tag");
    const afterDigest = readOutputFileSafe(outputPathC);
    expect(digestFound, 'SCENARIO 5: C\'s worker output file gains the [internal:paused-digest] notification text', afterDigest.slice(baselineOutputC.length).slice(0, 500));

    if (!digestFound) {
      // Diagnostic-only output -- not a new assertion, does not affect
      // pass/fail or the exit code. Distinguishes three failure shapes: the
      // flush never ran, the readiness gate capped out but the flush still
      // ran (or failed) afterward, or the write landed but late/elsewhere.
      scenario5DigestFailed = true;
      const stdoutSinceScenario5 = stdoutBuf.slice(stdoutLenBeforeScenario5);
      const markers: Array<{ name: string; text: string }> = [
        { name: 'readiness gate capped out', text: 'Agent worker was not ready before the deferred digest; proceeding' },
        { name: 'flush completed', text: 'Flushed deferred notifications' },
        { name: 'digest delivery failed', text: 'Failed to deliver the paused-session digest' },
        { name: 'read-more file write failed (flush aborted)', text: 'Failed to write the deferred read-more file' },
      ];
      console.log('\n==> SCENARIO 5 DIAGNOSTIC DUMP (digest never appeared within the wait window)');
      for (const marker of markers) {
        const matchingLines = stdoutSinceScenario5
          .split('\n')
          .filter((line) => line.includes(marker.text));
        if (matchingLines.length > 0) {
          console.log(`  [${marker.name}] YES:`);
          for (const line of matchingLines) console.log(`    ${line}`);
        } else {
          console.log(`  [${marker.name}] NO (not found in server stdout since the resume call)`);
        }
      }
      const remainingDeferredRows = countDeferredRows(sessionC.id, agentWorkerC.id);
      console.log(`  [deferred_worker_notifications rows remaining for C] ${remainingDeferredRows}`);
      console.log(`  [C's worker output file, last 1000 chars]\n${afterDigest.slice(-1000)}`);
      if (stderrBuf.length > 0) {
        console.log(`  [server stderr, last 1000 chars]\n${stderrBuf.slice(-1000)}`);
      }
      console.log('==> END SCENARIO 5 DIAGNOSTIC DUMP');
    }

    // ===================================================================
    // SCENARIO 6: a second resume_session from P returns changed:false (C
    // is already active).
    // ===================================================================
    console.log('\n==> SCENARIO 6: a second resume_session from P returns changed:false');
    const secondResumeRes = await callMcpTool(baseUrl, mcpSessionId, 'resume_session', {
      sessionId: sessionC.id,
      fromSessionId: sessionP.id,
    });
    expect(!secondResumeRes.isError, 'SCENARIO 6: the second resume_session call still succeeds', JSON.stringify(secondResumeRes.data));
    const secondResumeData = secondResumeRes.data as { changed?: boolean };
    expect(secondResumeData.changed === false, 'SCENARIO 6: the second resume_session reports changed:false', JSON.stringify(secondResumeData));
  } finally {
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    if (scenario5DigestFailed) {
      console.log(`\n==> KEEPING scratch root for inspection (SCENARIO 5 digest failure): ${scratchRoot}`);
    } else {
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
        console.log(`\n==> cleaned up scratch root: ${scratchRoot}`);
      } catch (err) {
        console.error(`==> WARNING: failed to clean up ${scratchRoot}: ${String(err)}`);
      }
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
