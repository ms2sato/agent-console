#!/usr/bin/env bun
/**
 * Shipping-path E2E for Issue #1414: an embedded-agent worker whose `claude`
 * grandchild dies alone, leaving the harness resident, must be replaced rather
 * than left permanently bricked.
 *
 * WHY THIS IS A SMOKE AND NOT A CI TEST. Reproducing the bug requires the real
 * thing at every layer: a real `claude-sdk` incarnation (so there is a real
 * `claude` grandchild to kill), a real authenticated `claude` CLI for the
 * invoking OS user, and real billed turns (the context-survival check is a
 * recall question across the process boundary). The unit layer covers the
 * routing, the crash-loop bound and the `openai-api` non-regression with a
 * fake spawn; what only the real chain can establish is that a SIGKILL to the
 * grandchild produces a `fatal` that this fix actually collects, and that the
 * SDK resume carries the conversation across the replacement.
 *
 * WHAT IS REAL HERE. Everything the fix touches:
 *   - a real `AppContext` (real SQLite under a disposable AGENT_CONSOLE_HOME,
 *     real `EmbeddedAgentWorkerService`, real `McpTokenRegistry`), not the
 *     unit tests' fake spawn and not a memfs-mocked environment;
 *   - a real subprocess tree (`sh` -> `bun` harness -> `claude`), spawned by
 *     the production `spawnAsUser` path;
 *   - a real `/mcp` endpoint served on a real port, which the harness dials
 *     with its real per-worker bearer token;
 *   - the production entry points a WebSocket client's frames land on:
 *     `activateEmbeddedAgentWorker` / `sendEmbeddedAgentUserMessage` /
 *     `getWorkerOutputHistory`.
 *
 * The one layer deliberately not driven is the WebSocket transport itself. The
 * fix changes nothing there, and going in-process is what makes the AC's
 * "confirmed against the authoritative store, not from frames" requirement
 * satisfiable at all: the MCP token registry is an in-memory server object, so
 * `registry.verify(oldToken) === null` is the authoritative revocation check
 * and no frame can substitute for it.
 *
 * CASES (all in one run, so a negative is never reported without the positive
 * control that makes it meaningful):
 *
 *   1. IDLE KILL -- the Issue's own repro. Plant a word, let the turn finish,
 *      SIGKILL the `claude` grandchild only, and assert: `fatal` arrives, the
 *      incarnation is replaced, the old harness is gone, the old MCP token no
 *      longer verifies, the persisted pid changed, and a resent message is
 *      answered WITH the planted word (the SDK resume carried the
 *      conversation). No `turn-interrupted` -- nothing was in flight.
 *
 *   2. MID-TURN KILL -- the interleaving that exercises the unfinished-turn
 *      marker deterministically rather than by timing luck. Send a message and
 *      SIGKILL the grandchild while that turn is in flight; assert the same
 *      recovery PLUS a `turn-interrupted` row naming that turn's id.
 *
 *   3. POSITIVE CONTROL, same run -- kill the whole tree instead. The healthy
 *      path must still behave as measured on unmodified main: a server-authored
 *      `exited` row, the worker back to idle, and no orphaned `claude`. This is
 *      what separates "the fix collects the unobserved death" from "the fix
 *      changed teardown generally".
 *
 * POLARITY. Run with `--expect-brick` against a build whose fix is removed:
 * every recovery assertion inverts, and case 1 must end with the worker still
 * holding its original harness and refusing messages with TURN_IN_PROGRESS.
 * The flag asserts the bug rather than merely tolerating it, so a run that
 * silently recovers is reported as a failure of the polarity check.
 *
 * Usage:
 *   bun scripts/smoke/check-fatal-incarnation-replacement.ts
 *   bun scripts/smoke/check-fatal-incarnation-replacement.ts --expect-brick
 *
 * Requirements:
 *   - A real, authenticated `claude` CLI session for the invoking OS user
 *     (same requirement as the SDK probes under this directory). Billable.
 *   - Single-user mode, which seeds a real `users` row from the OS uid, so
 *     the session has the `createdBy` that embedded-agent activation needs.
 *
 * Exit codes:
 *   0  every assertion in the selected mode passed
 *   1  an assertion failed (the smoke ran and the system is wrong)
 *   2  bad usage / the smoke could not run (boot failure, no worker tree, ...)
 */
import { mkdirSync, rmSync } from 'node:fs';
// Type-only, so it is erased at runtime and does not load the server modules
// before the env vars below are set (the value imports stay dynamic, further
// down, for exactly that reason).
import type { McpDependencies } from '../../packages/server/src/mcp/mcp-server.ts';
import * as os from 'node:os';
import * as path from 'node:path';

const EXPECT_BRICK = process.argv.includes('--expect-brick');
const SECRET_WORD = 'WOMBAT-3312';

/** A turn's worth of patience: real SDK turns are seconds, not milliseconds. */
const TURN_TIMEOUT_MS = 120_000;
/** How long recovery may take: deactivate escalation plus a fresh spawn. */
const RECOVERY_TIMEOUT_MS = 60_000;

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/**
 * Raised by {@link bail}. A dedicated type so the entry point can map it to
 * exit 2 (the smoke could not run) while every other throw keeps its own
 * handling.
 */
class BailError extends Error {}

/**
 * The smoke cannot run. THROWS rather than exiting, so `main`'s cleanup block
 * still runs: by the time most of these fire, a real `sh` -> harness ->
 * `claude` tree is live, and `process.exit` here would strand it on a shared
 * host -- on the failure path, which is exactly when nobody is looking for
 * orphans. The header's own account of a leftover worker producing a false
 * negative is what this protects the NEXT run from.
 */
function bail(message: string): never {
  throw new BailError(message);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(100);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

// --------------------------------------------------------------------------
// Process-tree helpers. The persisted `workers.pid` is the `sh` the server
// holds; the harness is its child and `claude` is the harness's child. Walking
// the tree from the SERVER'S OWN recorded pid (rather than `pgrep claude`) is
// deliberate: the Issue's own G1 measurement recorded a discarded run where a
// `pgrep` match killed a leftover worker from a previous run and produced a
// false negative.
// --------------------------------------------------------------------------

function childrenOf(pid: number): number[] {
  const out = Bun.spawnSync(['pgrep', '-P', String(pid)]);
  return new TextDecoder()
    .decode(out.stdout)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/**
 * Whether `pid` is a RESIDENT process. `kill -0` alone is not that question: it
 * succeeds for a zombie, which holds a slot in the table and nothing else. The
 * harness is this process's grandchild, so between its death and init reaping
 * it there is a window where "is the stranded process gone" would answer no
 * while the memory this Issue is about has already been released.
 */
function isAlive(pid: number): boolean {
  if (Bun.spawnSync(['kill', '-0', String(pid)]).exitCode !== 0) return false;
  const state = new TextDecoder()
    .decode(Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)]).stdout)
    .trim();
  return state !== '' && !state.startsWith('Z');
}

function commandOf(pid: number): string {
  const out = Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(pid)]);
  return new TextDecoder().decode(out.stdout).trim();
}

/** `[shPid, harnessPid, claudePid]` for a live worker, or null when incomplete. */
function resolveWorkerTree(shPid: number): { sh: number; harness: number; claude: number } | null {
  if (!isAlive(shPid)) return null;
  for (const harness of childrenOf(shPid)) {
    for (const claude of childrenOf(harness)) {
      if (commandOf(claude).includes('claude')) return { sh: shPid, harness, claude };
    }
  }
  return null;
}

async function waitForWorkerTree(shPid: number, timeoutMs: number): Promise<{ sh: number; harness: number; claude: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tree = resolveWorkerTree(shPid);
    if (tree) return tree;
    await delay(200);
  }
  return null;
}

// --------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  console.log(`==> mode: ${EXPECT_BRICK ? 'POLARITY (--expect-brick: the bug must reproduce)' : 'RECOVERY (the fix must hold)'}`);

  const disposableHome = path.join(os.tmpdir(), `agent-console-1414-${process.pid}-${Date.now()}`);
  const workCwd = path.join(disposableHome, 'work');
  mkdirSync(workCwd, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);

  // The port must be settled BEFORE the context is built: the embedded-agent
  // service resolves the MCP base URL the harness will dial from config that
  // is read at context-creation time.
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'none';
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  // Imported AFTER the env is set: config resolution reads these at module load.
  const { createAppContext, shutdownAppContext } = await import('../../packages/server/src/app-context.ts');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.ts');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.ts'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.ts');
  const { CLAUDE_SDK_AGENT_ID } = await import('../../packages/server/src/services/embedded-agent-manager.ts');

  const ctx = await createAppContext({ broadcastToApp: () => {} });

  // Observation seam, not a behaviour change: record every token the registry
  // mints so a later `verify()` against the AUTHORITATIVE registry can prove
  // the dead incarnation's token was revoked. Nothing about minting, verifying
  // or revoking changes -- this neither widens what the token reaches nor
  // relaxes what verifies it.
  const mintedTokens: string[] = [];
  const registry = ctx.mcpTokenRegistry;
  const originalMint = registry.mint.bind(registry);
  registry.mint = ((identity: Parameters<typeof originalMint>[0]) => {
    const token = originalMint(identity);
    mintedTokens.push(token);
    return token;
  }) as typeof registry.mint;

  // Only the MCP surface needs serving: the harness subprocess dials it over
  // real HTTP with its real per-worker bearer token. Everything else this
  // script drives goes through `sessionManager` directly -- the same entry
  // point the WebSocket route calls.
  const mcpDeps: McpDependencies = {
    sessionManager: ctx.sessionManager,
    repositoryManager: ctx.repositoryManager,
    agentManager: ctx.agentManager,
    agentDirectory: ctx.agentDirectory,
    timerManager: ctx.timerManager,
    conditionalWakeupManager: ctx.conditionalWakeupManager,
    interactiveProcessManager: ctx.interactiveProcessManager,
    worktreeService: ctx.worktreeService,
    annotationService: ctx.annotationService,
    interSessionMessageService: ctx.interSessionMessageService,
    suggestSessionMetadata: ctx.suggestSessionMetadata,
    createWorktreeWithSession,
    deleteWorktree,
    userRepository: ctx.userRepository,
    artifactRepository: ctx.artifactRepository,
    bookmarkRepository: ctx.bookmarkRepository,
    broadcastToApp: () => {},
    fetchPullRequestUrl: ctx.fetchPullRequestUrl,
    findOpenPullRequest: ctx.findOpenPullRequest,
    mcpTokenRegistry: ctx.mcpTokenRegistry,
  };
  const mcpApp = createMcpApp(mcpDeps);
  const server = Bun.serve({ fetch: mcpApp.fetch, port, hostname: '127.0.0.1' });
  console.log(`==> real /mcp served at http://127.0.0.1:${server.port}/mcp`);

  const sm = ctx.sessionManager;

  async function readEvents(sessionId: string, workerId: string): Promise<StreamEvent[]> {
    const hist = await sm.getWorkerOutputHistory(sessionId, workerId);
    if (!hist) return [];
    const events: StreamEvent[] = [];
    for (const line of hist.data.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line) as StreamEvent);
      } catch {
        // A previous incarnation may have been killed mid-write.
      }
    }
    return events;
  }

  /**
   * Wait for a turn boundary AFTER a recorded point in the stream. Checking
   * `some(state === idle)` over the whole stream is always true once any turn
   * has finished, so every wait here is relative to a marker taken before the
   * thing being waited on.
   */
  async function waitForIdleAfter(sessionId: string, workerId: string, marker: number, what: string): Promise<boolean> {
    return waitFor(
      async () =>
        (await readEvents(sessionId, workerId))
          .slice(marker)
          .some((e) => e.type === 'state' && e.state === 'idle'),
      TURN_TIMEOUT_MS,
      what,
    );
  }

  /**
   * The pid the server has PERSISTED for this worker -- read from the real
   * SQLite row, not from a broadcast frame. This is the same field the Issue's
   * G1 measurement addressed the process by, and reading it here (rather than
   * the in-memory handle) is what makes "the incarnation was replaced" a
   * statement about the authoritative store.
   */
  async function currentPid(workerId: string): Promise<number | null> {
    const row = await ctx.db
      .selectFrom('workers')
      .select('pid')
      .where('id', '=', workerId)
      .executeTakeFirst();
    return row?.pid ?? null;
  }

  let sessionId = '';
  let workerId = '';
  try {
    // The same identity the API middleware resolves for every request in
    // single-user mode: the server process user, upserted into `users` at
    // context creation. Activation needs it to mint an MCP caller identity.
    const authUser = ctx.userMode.authenticate(() => undefined);
    const session = await sm.createSession(
      { type: 'quick', locationPath: workCwd },
      { createdBy: authUser.id },
    );
    sessionId = session.id;
    if (!session.createdBy) {
      bail('the created session has no createdBy; embedded-agent activation cannot mint an MCP identity');
    }
    const worker = await sm.createWorker(sessionId, {
      type: 'embedded-agent',
      embeddedAgentId: CLAUDE_SDK_AGENT_ID,
    });
    if (!worker) bail('worker creation returned null');
    workerId = worker.id;

    await sm.activateEmbeddedAgentWorker(sessionId, workerId);
    const ready = await waitFor(
      async () => (await readEvents(sessionId, workerId)).some((e) => e.type === 'ready'),
      TURN_TIMEOUT_MS,
      'the first incarnation to report ready',
    );
    if (!ready) bail('the first incarnation never reported ready; the SDK harness could not start');

    // ====================================================================
    // CASE 1 -- IDLE KILL: the Issue's exact repro.
    // ====================================================================
    console.log('\n==> CASE 1: idle kill (the Issue\'s repro)');

    const plantMarker = (await readEvents(sessionId, workerId)).length;
    const plant = await sm.sendEmbeddedAgentUserMessage(
      sessionId,
      workerId,
      `Remember this secret word: ${SECRET_WORD}. Reply with only OK.`,
    );
    if (!plant.ok) bail(`the planting message was refused: ${JSON.stringify(plant)}`);
    const answered = await waitForIdleAfter(sessionId, workerId, plantMarker, 'the planting turn to complete');
    if (!answered) bail('the first turn never completed; there is nothing to kill');

    const shPid = (await currentPid(workerId));
    if (shPid === null) bail('the server holds no pid for the activated worker');
    const tree = await waitForWorkerTree(shPid, 15_000);
    if (!tree) bail(`could not resolve sh(${shPid}) -> harness -> claude; the tree shape this Issue is about is absent`);
    console.log(`    tree: sh=${tree.sh} harness=${tree.harness} claude=${tree.claude}`);

    const tokenBefore = mintedTokens[mintedTokens.length - 1];
    const eventsBeforeKill = (await readEvents(sessionId, workerId)).length;

    // The kill this Issue is about: the grandchild ONLY.
    Bun.spawnSync(['kill', '-9', String(tree.claude)]);
    console.log(`    SIGKILL -> ${tree.claude} (the claude grandchild only)`);

    const sawFatal = await waitFor(
      async () => (await readEvents(sessionId, workerId)).some((e) => e.type === 'fatal'),
      30_000,
      'the engine to report fatal',
    );
    check(sawFatal, 'the engine reports `fatal` when its child dies alone');

    if (EXPECT_BRICK) {
      // The bug, asserted rather than tolerated.
      await delay(15_000);
      const stillOriginal = (await currentPid(workerId)) === shPid && isAlive(tree.harness);
      check(stillOriginal, 'POLARITY: the original harness is still resident and unreplaced', `pid=${(await currentPid(workerId))}`);
      const first = await sm.sendEmbeddedAgentUserMessage(sessionId, workerId, 'first message after the SDK died');
      const second = await sm.sendEmbeddedAgentUserMessage(sessionId, workerId, 'second message after the SDK died');
      check(first.ok === true, 'POLARITY: the first message after the death is still admitted');
      check(
        second.ok === false && (second as { code?: string }).code === 'TURN_IN_PROGRESS',
        'POLARITY: every later message is refused with TURN_IN_PROGRESS -- the brick',
        JSON.stringify(second),
      );
      const evs = await readEvents(sessionId, workerId);
      check(!evs.some((e) => e.type === 'exited'), 'POLARITY: no `exited` row -- the server never observed the death');
    } else {
      const replaced = await waitFor(
        async () => {
          const pid = await currentPid(workerId);
          return pid !== null && pid !== shPid;
        },
        RECOVERY_TIMEOUT_MS,
        'the incarnation to be replaced',
      );
      check(replaced, 'the incarnation is replaced', `pid ${shPid} -> ${(await currentPid(workerId))}`);
      // Waited, not sampled: the pid changing means the SERVER moved on, which
      // is not the same instant the OS finished tearing the old tree down.
      check(
        await waitFor(() => !isAlive(tree.harness), 15_000, 'the stranded harness to terminate'),
        'the stranded harness process is gone, not left resident',
      );
      check(
        await waitFor(() => !isAlive(tree.sh), 15_000, 'the stranded `sh` to terminate'),
        'the stranded `sh` is gone too',
      );

      const evs = await readEvents(sessionId, workerId);
      check(
        evs.slice(eventsBeforeKill).some((e) => e.type === 'exited'),
        'a server-authored `exited` row is appended -- the death is now observed',
      );
      check(
        !evs.slice(eventsBeforeKill).some((e) => e.type === 'turn-interrupted'),
        'no `turn-interrupted` marker: nothing was in flight at an idle kill',
      );

      // AUTHORITATIVE STORE, not frames: the registry itself.
      check(
        tokenBefore !== undefined && registry.verify(tokenBefore) === null,
        'the dead incarnation\'s MCP token no longer verifies against the registry',
      );
      const tokenAfter = mintedTokens[mintedTokens.length - 1];
      check(
        tokenAfter !== undefined && tokenAfter !== tokenBefore && registry.verify(tokenAfter) !== null,
        'the replacement holds a distinct, live token',
      );

      const readyAgain = await waitFor(
        async () => (await readEvents(sessionId, workerId)).filter((e) => e.type === 'ready').length >= 2,
        RECOVERY_TIMEOUT_MS,
        'the replacement incarnation to report ready',
      );
      check(readyAgain, 'the replacement incarnation reports ready');

      const before = (await readEvents(sessionId, workerId)).length;
      const recall = await sm.sendEmbeddedAgentUserMessage(
        sessionId,
        workerId,
        'What was the secret word I told you? Reply with only the word.',
      );
      check(recall.ok === true, 'a message sent after the recovery is admitted -- the brick is gone', JSON.stringify(recall));
      const recalled = await waitFor(
        async () => {
          const evs2 = await readEvents(sessionId, workerId);
          return evs2
            .slice(before)
            .some((e) => e.type === 'assistant-message' && String(e.text ?? '').includes(SECRET_WORD));
        },
        TURN_TIMEOUT_MS,
        'the replacement to recall the planted word',
      );
      check(recalled, `the conversation survived the process boundary (recalled ${SECRET_WORD})`);
      // Settle the recall turn before Case 2 sends into the same worker.
      await waitForIdleAfter(sessionId, workerId, before, 'the recall turn to complete');
    }

    if (EXPECT_BRICK) {
      console.log('\n==> polarity mode: cases 2 and 3 are skipped (they assert the fixed behaviour)');
    } else {
      // ==================================================================
      // CASE 2 -- MID-TURN KILL: drives the turn-interrupted marker
      // deterministically rather than hoping for an interleaving.
      // ==================================================================
      console.log('\n==> CASE 2: mid-turn kill (unfinished-turn marker)');

      const shPid2 = (await currentPid(workerId));
      if (shPid2 === null) bail('no pid for the replacement incarnation');
      const tree2 = await waitForWorkerTree(shPid2, 15_000);
      if (!tree2) bail('could not resolve the replacement incarnation\'s process tree');

      const marker = (await readEvents(sessionId, workerId)).length;
      const inFlight = await sm.sendEmbeddedAgentUserMessage(
        sessionId,
        workerId,
        'Count slowly from 1 to 40, one number per line, and then say DONE.',
      );
      if (!inFlight.ok) bail(`the mid-turn message was refused: ${JSON.stringify(inFlight)}`);
      const turnId = (inFlight as { id?: string }).id;
      // Without this the identity check below degenerates to
      // `e.turnId === undefined`, which a `turn-interrupted` row carrying no
      // `turnId` satisfies -- so Case 2 could report PASS while proving only
      // that SOME marker exists, not that the marker names the turn we killed.
      // This is the apparatus that verifies the fix; an assertion here that can
      // succeed vacuously is worse than no assertion at all.
      if (turnId === undefined || turnId === '') {
        bail('the mid-turn message returned no id, so the turn-interrupted marker could not be attributed');
      }

      // Wait until the turn is genuinely in flight before killing.
      const active = await waitFor(
        async () => (await readEvents(sessionId, workerId)).slice(marker).some((e) => e.type === 'state' && e.state === 'active'),
        TURN_TIMEOUT_MS,
        'the turn to go active',
      );
      if (!active) bail('the mid-turn message never started a turn');
      Bun.spawnSync(['kill', '-9', String(tree2.claude)]);
      console.log(`    SIGKILL -> ${tree2.claude} mid-turn`);

      const replaced2 = await waitFor(
        async () => {
          const pid = await currentPid(workerId);
          return pid !== null && pid !== shPid2;
        },
        RECOVERY_TIMEOUT_MS,
        'the mid-turn incarnation to be replaced',
      );
      check(replaced2, 'a mid-turn death is also replaced');

      const marked = await waitFor(
        async () =>
          (await readEvents(sessionId, workerId))
            .slice(marker)
            .some((e) => e.type === 'turn-interrupted' && e.turnId === turnId),
        RECOVERY_TIMEOUT_MS,
        'the turn-interrupted marker for the killed turn',
      );
      check(marked, 'the unfinished turn is marked `turn-interrupted` by the next incarnation', `turnId=${turnId}`);

      const afterMarker = (await readEvents(sessionId, workerId)).length;
      const after = await sm.sendEmbeddedAgentUserMessage(sessionId, workerId, 'Reply with only OK.');
      check(after.ok === true, 'the worker accepts messages again after a mid-turn death', JSON.stringify(after));

      // ==================================================================
      // CASE 3 -- POSITIVE CONTROL: the healthy whole-tree kill, same run.
      // ==================================================================
      console.log('\n==> CASE 3: positive control (whole-tree kill)');

      await waitForIdleAfter(sessionId, workerId, afterMarker, 'the worker to settle idle before the control');
      const shPid3 = (await currentPid(workerId));
      if (shPid3 === null) bail('no pid for the control incarnation');
      const tree3 = await waitForWorkerTree(shPid3, 15_000);
      if (!tree3) bail('could not resolve the control incarnation\'s process tree');
      const controlMarker = (await readEvents(sessionId, workerId)).length;
      const controlToken = mintedTokens[mintedTokens.length - 1];

      const t0 = Date.now();
      Bun.spawnSync(['kill', '-9', String(tree3.sh)]);
      console.log(`    SIGKILL -> ${tree3.sh} (the whole tree)`);

      const observed = await waitFor(
        async () => (await readEvents(sessionId, workerId)).slice(controlMarker).some((e) => e.type === 'exited'),
        30_000,
        'the control exit to be observed',
      );
      check(observed, 'the healthy whole-tree kill still produces an observed `exited`', `${Date.now() - t0}ms`);
      check(
        controlToken !== undefined && registry.verify(controlToken) === null,
        'the control kill revokes its token too',
      );
      check(
        await waitFor(() => !isAlive(tree3.claude), 15_000, 'the control `claude` to terminate'),
        'no orphaned `claude` survives the whole-tree kill',
      );
    }
  } finally {
    try {
      if (sessionId && workerId) await sm.deactivateEmbeddedAgentWorker?.(sessionId, workerId);
    } catch {
      // best effort
    }
    server.stop(true);
    await shutdownAppContext(ctx);
    try {
      rmSync(disposableHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  console.log(`\n==> ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  if (err instanceof BailError) {
    console.error(`\nCOULD NOT RUN: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  console.error('\nCOULD NOT RUN: the smoke threw before it could finish');
  process.exit(2);
});
