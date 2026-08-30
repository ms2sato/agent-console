#!/usr/bin/env bun
/**
 * Shipping-path smoke for R6 (#1447 stage 4, Issue #1492): the persistent
 * `restore-failure-declaration` marker a `claude-sdk` worker's FALLBACK reset
 * writes when its `sdkSessionId` survives the reset -- and, critically, that
 * the marker outlives the incarnation that wrote it.
 *
 * FREE AND DETERMINISTIC. No real `claude` CLI, no real subprocess of any
 * kind, no billing. R6's actual verification target -- "the fallback path's
 * marker gets written, and the NEXT read/restore correctly classifies it as
 * noise (not a boundary), surviving into a later incarnation" -- is a pure
 * filesystem+parsing property. It does not depend on what a real LLM turn
 * produces, so a scripted NDJSON fixture applied through the REAL event
 * handler is sufficient. Contrast `check-fatal-incarnation-replacement.ts`
 * (same directory), which genuinely needs a live `claude` grandchild and is
 * billable -- this script needs neither.
 *
 * WHAT IS REAL HERE:
 *   - a real `AppContext` (real SQLite under a disposable AGENT_CONSOLE_HOME);
 *   - real DB rows for the session, the two `EmbeddedAgentDefinition`s, and
 *     every worker, created via the real services (`sessionManager`,
 *     `embeddedAgentManager`), never hand-inserted;
 *   - a real, disk-backed `WorkerOutputFileManager` -- every read/write in
 *     this script goes through the SAME production class the server uses,
 *     against real files under `os.tmpdir()`, never memfs;
 *   - a real `EmbeddedAgentWorkerService.runActivation` / `.deactivate` /
 *     `.sendUserMessage` -- the exact production methods a WebSocket route
 *     calls -- driving the real R1 catch-block inversion and the real R6
 *     write in `resetWorkerOutput`;
 *   - the `sdk-session-id` event that sets `worker.sdkSessionId` is applied
 *     through the service's REAL stdout line handler (`handleLoopLine`), by
 *     pushing a scripted NDJSON line through a fake subprocess's stdout --
 *     not a hand-written DB/field mutation. The persisted line and the
 *     in-memory field both come from the one real code path that produces
 *     them in production.
 *
 * WHAT IS FAKED: `spawnAsUserFn` returns an in-process stub subprocess (a
 * controllable stdout/stderr pair, a swallowing stdin, a `kill()` that
 * resolves `exited`) instead of launching an OS process. R6's target
 * property lives entirely below the spawn boundary -- in the output file and
 * the restore reader -- so nothing about the spawn step is under test here.
 *
 * test-trigger.md's "the conversation must use a tool" rule -- NOT
 * APPLICABLE, stated so nobody goes looking. That rule protects
 * reconstruction of a conversation that SURVIVES a restart, guarding the
 * openai-api/claude-sdk tool-call-ordering defect. Case 1's established
 * conversation never survives one here: the forced fallback resets and
 * discards it unconditionally (that reset is the scenario under test), so
 * no activation in this script ever reconstructs it. There is no tool-call
 * ordering for a tool-using turn to protect.
 *
 * THE FAULT-INJECTION MECHANISM: an EACCES/EISDIR ASYMMETRY BETWEEN
 * `appendRestoreFailureMarker` AND `resetWorkerOutput`'s FALLBACK STEPS.
 *
 * `appendRestoreFailureMarker` (R1's PRIMARY path) does `fs.appendFile` on
 * the EXISTING live output file -- opening an existing file for append needs
 * WRITE PERMISSION ON THE FILE ITSELF. `resetWorkerOutput`'s fallback does
 * `fs.rename` (moves the live file to the sidecar path -- needs write
 * permission on the CONTAINING DIRECTORY for source and destination, not on
 * the file being moved) followed by `fs.writeFile` at the ORIGINAL live path
 * (creates a brand-new file there once the old one has been moved out --
 * again a directory-permission operation, unaffected by the OLD file's mode
 * bits). So: chmod the live file to `0o444` (read-only) BEFORE the second
 * activation. The primary path's `appendFile` fails with EACCES; the
 * fallback's rename+recreate on the SAME directory is untouched by that
 * chmod and succeeds -- deterministically driving R1's fallback branch
 * without needing any other kind of injected failure. This is the exact
 * reasoning the Orchestrator asked to have recorded here, for the next
 * reader who considers changing the chmod granularity: it has to be the
 * FILE's mode, not the directory's, or the fallback would fail too.
 *
 * CASES (all in one run):
 *
 *   1. POSITIVE: a `claude-sdk` worker whose `sdkSessionId` survives a
 *      forced fallback reset gets the persistent `restore-failure-declaration`
 *      row written into the fresh live file -- confirmed as that file's sole
 *      content, confirmed the FALLBACK branch (not the primary) actually ran
 *      (`preservation !== 'in-band'`), and confirmed the marker is STILL
 *      present, unmoved, after a SECOND restore succeeds against that fresh
 *      file (a real later incarnation, not a re-read of the same one) --
 *      the actual R6 property: the declaration outlives the incarnation
 *      that wrote it, because nothing incarnation-scoped holds it.
 *
 *   2. NEGATIVE, `openai-api` engine: the identical forced-fallback sequence
 *      against an `openai-api` worker writes no such row -- reconstruction
 *      IS that engine's memory, so a Loss there is already symmetric and
 *      already declared by the failure form alone.
 *
 *   3. NEGATIVE, `claude-sdk` engine with a NULL `sdkSessionId` (never
 *      received an `sdk-session-id` event): the identical forced-fallback
 *      sequence writes no row either -- nothing survives the reset to
 *      declare.
 *
 * POLARITY. Run with `--expect-no-declaration` to assert the DEFECT
 * reproduces rather than merely tolerating a failure: this mode wraps
 * `workerOutputFileManager.resetWorkerOutput` to strip `persistentMarkerLine`
 * from every call before delegating to the real implementation -- simulating
 * "the R6 fix is absent" at the exact call site the fix uses, without
 * touching source. Case 1's fresh file must then be EMPTY, and a run that
 * finds the marker anyway is reported as a polarity failure. Same discipline
 * as `check-fatal-incarnation-replacement.ts --expect-brick`.
 *
 * Usage:
 *   bun scripts/smoke/check-restore-failure-declaration.ts
 *   bun scripts/smoke/check-restore-failure-declaration.ts --expect-no-declaration
 *
 * Exit codes:
 *   0  every assertion in the selected mode passed
 *   1  an assertion failed (the smoke ran and the system is wrong)
 *   2  bad usage / the smoke could not run
 */
import { mkdirSync, rmSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSink, Subprocess } from 'bun';
import type { EmbeddedAgentDefinition, EmbeddedAgentStreamEvent } from '@agent-console/shared';
import type { WorkerOutputFileManager } from '../../packages/server/src/lib/worker-output-file.ts';

const EXPECT_NO_DECLARATION = process.argv.includes('--expect-no-declaration');

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

class BailError extends Error {}
function bail(message: string): never {
  throw new BailError(message);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(20);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

// ----------------------------------------------------------------------
// Fake spawn: an in-process stub subprocess. No OS process is ever
// launched -- R6's target property lives below the spawn boundary.
// ----------------------------------------------------------------------

interface FakeSubprocessHandle {
  push: (line: string) => void;
  killAndSettle: (code: number) => void;
}

function makeFakeSubprocess(): { spawnAsUserFn: (opts: { username: unknown; command: string; cwd?: string }) => { subprocess: Subprocess<'pipe', 'pipe', 'pipe'>; stdin: FileSink; elevated: boolean }; handle: FakeSubprocessHandle } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // The stderr controller must be captured and closed too -- `readStderr`
  // loops `reader.read()` until `done`, exactly like `readStdout`. An
  // uncaptured stderr controller can never signal `done`, and
  // `runtime.streamsDone` (a `Promise.all` of BOTH readers) then never
  // resolves -- `deactivate()` awaits `streamsDone` and hangs forever. This
  // was measured, not assumed: the first draft of this script hung exactly
  // here, diagnosed by checkpoint logging that isolated it to `deactivate()`.
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => { stderrController = c; } });
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
  let closed = false;

  const stdin: FileSink = {
    write: () => 0,
    end: () => {},
    flush: () => 0,
  } as unknown as FileSink;

  const settle = (code: number): void => {
    if (closed) return;
    closed = true;
    controller.close();
    stderrController.close();
    resolveExited(code);
  };

  const subprocess = {
    pid: Math.floor(Math.random() * 100_000) + 1,
    exited,
    stdin,
    stdout,
    stderr,
    kill: (_signal?: number) => settle(0),
  } as unknown as Subprocess<'pipe', 'pipe', 'pipe'>;

  const handle: FakeSubprocessHandle = {
    push: (line: string) => controller.enqueue(enc.encode(`${line}\n`)),
    killAndSettle: (code: number) => settle(code),
  };

  const spawnAsUserFn = () => ({ subprocess, stdin, elevated: false });
  return { spawnAsUserFn, handle };
}

// ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`==> mode: ${EXPECT_NO_DECLARATION ? 'POLARITY (--expect-no-declaration: the defect must reproduce)' : 'FIX (R6 must hold)'}`);

  const disposableHome = path.join(os.tmpdir(), `agent-console-r6-${process.pid}-${Date.now()}`);
  const cwd = path.join(disposableHome, 'work');
  mkdirSync(cwd, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'none';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  // Imported AFTER the env is set: config resolution reads these at module load.
  const { createAppContext, shutdownAppContext } = await import('../../packages/server/src/app-context.ts');
  const { EmbeddedAgentWorkerService } = await import('../../packages/server/src/services/embedded-agent-worker-service.ts');
  const { WorkerOutputFileManager: WOFM } = await import('../../packages/server/src/lib/worker-output-file.ts');
  const { claudeSdkAgent, CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agents/claude-sdk-builtin.ts'
  );
  const { buildInternalQuickSession, buildInternalEmbeddedAgentWorker } = await import(
    '../../packages/server/src/__tests__/utils/build-test-data.ts'
  );

  const ctx = await createAppContext({ broadcastToApp: () => {} });

  let disposed = false;
  try {
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser?.id) bail('no authenticated user; embedded-agent activation cannot mint an MCP identity');

    // Real DB row for the openai-api definition the negative control needs.
    // `claudeSdkAgent` (the builtin) is real too -- registered by
    // `EmbeddedAgentManager.initialize()`, never hand-inserted.
    const openaiDef: EmbeddedAgentDefinition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'R6 smoke openai-api', provider: { baseUrl: 'http://127.0.0.1:1/v1', model: 'unused' } },
      authUser.id,
    );

    // Three REAL sessions + REAL workers (real SQLite rows via the real
    // service), one per case.
    const sessionCase1 = await ctx.sessionManager.createSession({ type: 'quick', locationPath: cwd }, { createdBy: authUser.id });
    const workerCase1 = await ctx.sessionManager.createWorker(sessionCase1.id, { type: 'embedded-agent', embeddedAgentId: CLAUDE_SDK_AGENT_ID });
    const sessionCase2 = await ctx.sessionManager.createSession({ type: 'quick', locationPath: cwd }, { createdBy: authUser.id });
    const workerCase2 = await ctx.sessionManager.createWorker(sessionCase2.id, { type: 'embedded-agent', embeddedAgentId: openaiDef.id });
    const sessionCase3 = await ctx.sessionManager.createSession({ type: 'quick', locationPath: cwd }, { createdBy: authUser.id });
    const workerCase3 = await ctx.sessionManager.createWorker(sessionCase3.id, { type: 'embedded-agent', embeddedAgentId: CLAUDE_SDK_AGENT_ID });
    if (!workerCase1 || !workerCase2 || !workerCase3) bail('worker creation returned null for at least one case');

    // Real, disk-backed resolvers for each real session -- the SAME public
    // method `routes.ts` uses, resolving into the SAME AGENT_CONSOLE_HOME.
    const resolver1 = ctx.sessionManager.getPathResolverForSessionId(sessionCase1.id);
    const resolver2 = ctx.sessionManager.getPathResolverForSessionId(sessionCase2.id);
    const resolver3 = ctx.sessionManager.getPathResolverForSessionId(sessionCase3.id);
    if (!resolver1 || !resolver2 || !resolver3) bail('could not resolve a real path resolver for at least one session');

    // The in-memory `InternalSession`/`InternalEmbeddedAgentWorker` runtime
    // objects the standalone service below operates on. Their IDENTITY
    // (session id, worker id) is the REAL DB-persisted identity created
    // above; only the runtime shape (subprocess handle, connection
    // callbacks, epoch/offset bookkeeping) is freshly assembled, exactly the
    // shape `WorkerManager` reconstructs from a persisted row after a server
    // restart.
    const internalWorker1 = buildInternalEmbeddedAgentWorker({ id: workerCase1.id, embeddedAgentId: CLAUDE_SDK_AGENT_ID });
    const internalWorker2 = buildInternalEmbeddedAgentWorker({ id: workerCase2.id, embeddedAgentId: openaiDef.id });
    const internalWorker3 = buildInternalEmbeddedAgentWorker({ id: workerCase3.id, embeddedAgentId: CLAUDE_SDK_AGENT_ID });
    const internalSession1 = buildInternalQuickSession([internalWorker1], { id: sessionCase1.id, locationPath: cwd, createdBy: authUser.id } as never);
    const internalSession2 = buildInternalQuickSession([internalWorker2], { id: sessionCase2.id, locationPath: cwd, createdBy: authUser.id } as never);
    const internalSession3 = buildInternalQuickSession([internalWorker3], { id: sessionCase3.id, locationPath: cwd, createdBy: authUser.id } as never);
    const sessionsById = new Map([
      [sessionCase1.id, internalSession1],
      [sessionCase2.id, internalSession2],
      [sessionCase3.id, internalSession3],
    ]);
    const resolversById = new Map([
      [sessionCase1.id, resolver1],
      [sessionCase2.id, resolver2],
      [sessionCase3.id, resolver3],
    ]);
    const definitionsById = new Map<string, EmbeddedAgentDefinition>([
      [CLAUDE_SDK_AGENT_ID, claudeSdkAgent],
      [openaiDef.id, openaiDef],
    ]);

    // A REAL, disk-backed WorkerOutputFileManager -- the exact production
    // class, operating on real files under the disposable AGENT_CONSOLE_HOME.
    // A fresh instance (not `ctx`'s internal one, which is unreachable from
    // this script's public surface) is file-state-equivalent: its behaviour
    // is entirely a function of what is on disk, not of any in-memory state
    // shared with another instance.
    const wofm: WorkerOutputFileManager = new WOFM();

    // POLARITY: wrap `resetWorkerOutput` to strip `persistentMarkerLine`
    // before delegating, simulating "the R6 fix is absent" at the exact
    // call site the fix uses. Every other behaviour (real fallback reset,
    // real disk write) is untouched.
    const realReset = wofm.resetWorkerOutput.bind(wofm);
    if (EXPECT_NO_DECLARATION) {
      wofm.resetWorkerOutput = (async (sessionId: string, workerId: string, resolver: unknown, opts?: Record<string, unknown>) => {
        const strippedOpts = opts ? { ...opts, persistentMarkerLine: undefined } : opts;
        return realReset(sessionId, workerId, resolver as never, strippedOpts as never);
      }) as typeof wofm.resetWorkerOutput;
    }

    const spawns = new Map<string, FakeSubprocessHandle>();
    function spawnAsUserFn(opts: { username: unknown; command: string; cwd?: string }): { subprocess: Subprocess<'pipe', 'pipe', 'pipe'>; stdin: FileSink; elevated: boolean } {
      const { spawnAsUserFn: fn, handle } = makeFakeSubprocess();
      // Keyed by cwd, which this harness sets to the SAME real dir for every
      // worker -- fine, since only one worker is ever mid-activation at a
      // time in this script's sequential flow, and each `activate()` call
      // immediately overwrites the map entry any earlier one no longer needs.
      spawns.set('current', handle);
      return fn(opts);
    }

    const service = new EmbeddedAgentWorkerService({
      getSession: (id) => sessionsById.get(id) as never,
      persistSession: async () => {},
      getPathResolver: (session) => resolversById.get(session.id)! as never,
      getEmbeddedAgent: (id) => definitionsById.get(id),
      resolveSpawnUsername: async () => os.userInfo().username,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
      workerOutputFileManager: wofm,
      getMcpBaseUrl: () => '',
      spawnAsUserFn: spawnAsUserFn as never,
      entryPath: 'unused-entry-path-fake-spawn-never-execs-it',
      getGlobalActivityCallback: () => undefined,
      getGlobalWorkerExitCallback: () => undefined,
      shutdownGraceMs: 20,
      sigtermTimeoutMs: 20,
    });

    async function readEvents(sessionId: string, workerId: string, resolver: never): Promise<EmbeddedAgentStreamEvent[]> {
      const hist = await wofm.readHistoryWithOffset(sessionId, workerId, resolver);
      const events: EmbeddedAgentStreamEvent[] = [];
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          events.push(JSON.parse(line) as EmbeddedAgentStreamEvent);
        } catch {
          // tolerated -- the same shape a real reader tolerates
        }
      }
      return events;
    }

    /**
     * Drives one worker through: activate (first-ever, real reset) -> a
     * real user-message turn -> a scripted assistant reply -> a real
     * `sdk-session-id` line (for claude-sdk cases; skipped for the
     * openai-api negative control, which has no such concept) -> deactivate.
     * Every write is through the REAL `EmbeddedAgentWorkerService` /
     * `WorkerOutputFileManager` code paths; the `sdk-session-id` line is
     * applied through the service's own stdout line handler, not a
     * hand-written field mutation.
     */
    async function establishIncarnation(sessionId: string, workerId: string, resolver: never, engine: 'claude-sdk' | 'openai-api'): Promise<void> {
      await service.activate(sessionId, workerId);
      const handle = spawns.get('current');
      if (!handle) bail('no fake subprocess handle recorded after activate()');
      handle.push(JSON.stringify({ v: 1, type: 'ready' }));
      const readyReported = await waitFor(async () => (await readEvents(sessionId, workerId, resolver)).some((e) => e.type === 'ready'), 2000, 'ready to be persisted');
      if (!readyReported) bail('the fake incarnation never reported ready');

      const send = await service.sendUserMessage(sessionId, workerId, 'hello (R6 smoke fixture)');
      if (!send.ok) bail(`sendUserMessage was refused: ${JSON.stringify(send)}`);
      handle.push(JSON.stringify({ v: 1, type: 'assistant-message', turnId: send.id, text: 'hi (R6 smoke fixture)' }));
      handle.push(JSON.stringify({ v: 1, type: 'state', state: 'idle' }));
      if (engine === 'claude-sdk') {
        handle.push(JSON.stringify({ v: 1, type: 'sdk-session-id', sdkSessionId: `sess-r6-smoke-${workerId}` }));
      }
      const settled = await waitFor(
        async () => (await readEvents(sessionId, workerId, resolver)).some((e) => e.type === 'state' && (e as { state?: string }).state === 'idle'),
        2000,
        'the scripted turn to settle idle',
      );
      if (!settled) bail('the scripted turn never settled idle');

      await service.deactivate(sessionId, workerId);
    }

    /**
     * Force the fallback: corrupt the live file, chmod it read-only,
     * activate again. Deliberately does NOT deactivate -- `getRestoreInfo`
     * reads from the LIVE incarnation's runtime state, which is torn down
     * (and returns null) the moment that incarnation deactivates. Callers
     * that need to observe `getRestoreInfo` must do so BEFORE calling
     * `deactivateAfterFallback` below.
     */
    async function forceFallback(sessionId: string, workerId: string, resolver: never): Promise<string> {
      const liveOutputPath = resolver!.getOutputFilePath(sessionId, workerId);
      const before = readFileSync(liveOutputPath, 'utf-8');
      if (!before.endsWith('\n')) appendFileSync(liveOutputPath, '\n');
      appendFileSync(liveOutputPath, '{not valid json');
      chmodSync(liveOutputPath, 0o444);

      await service.activate(sessionId, workerId);
      const handle = spawns.get('current');
      if (!handle) bail('no fake subprocess handle recorded after the fallback activation');
      // The fallback activation still spawns (it always does, restore
      // failure or not) -- settle it immediately, no scripted conversation
      // needed for this incarnation.
      handle.push(JSON.stringify({ v: 1, type: 'ready' }));
      await waitFor(async () => (await readEvents(sessionId, workerId, resolver)).some((e) => e.type === 'ready'), 2000, 'ready after the forced-fallback activation');
      return liveOutputPath;
    }

    async function deactivateAfterFallback(sessionId: string, workerId: string): Promise<void> {
      await service.deactivate(sessionId, workerId);
    }

    // ====================================================================
    // CASE 1 -- POSITIVE: claude-sdk, sdkSessionId survives the reset.
    // ====================================================================
    console.log('\n==> CASE 1: claude-sdk worker with a surviving sdkSessionId');

    await establishIncarnation(sessionCase1.id, workerCase1.id, resolver1 as never, 'claude-sdk');
    check(internalWorker1.sdkSessionId !== null, 'sdkSessionId was set on the worker via the REAL sdk-session-id event handler', `sdkSessionId=${internalWorker1.sdkSessionId}`);

    const liveOutputPath1 = await forceFallback(sessionCase1.id, workerCase1.id, resolver1 as never);

    const infoAfterFallback = service.getRestoreInfo(workerCase1.id);
    check(infoAfterFallback !== null && infoAfterFallback.failed === true, 'the forced-fallback activation reports a restore FAILURE', JSON.stringify(infoAfterFallback));
    check(
      infoAfterFallback !== null && infoAfterFallback.failed === true && infoAfterFallback.preservation !== 'in-band',
      'the FALLBACK branch actually ran, not the primary preserve-and-declare branch (observed, not assumed)',
      `preservation=${infoAfterFallback && infoAfterFallback.failed === true ? infoAfterFallback.preservation : undefined}`,
    );

    await deactivateAfterFallback(sessionCase1.id, workerCase1.id);

    chmodSync(liveOutputPath1, 0o644);
    const freshContent1 = readFileSync(liveOutputPath1, 'utf-8').trim();
    const declarationLine = JSON.stringify({ v: 1, type: 'restore-failure-declaration' });
    if (EXPECT_NO_DECLARATION) {
      check(freshContent1 === '', 'POLARITY: the fresh file is EMPTY -- the defect (no R6 declaration) reproduces', JSON.stringify(freshContent1));
    } else {
      check(freshContent1 === declarationLine, 'the fresh (post-reset) live file\'s sole content is the restore-failure-declaration marker', JSON.stringify(freshContent1));

      // A THIRD activation: a real LATER incarnation restoring against this
      // fresh file. Must SUCCEED (no corruption here), and the marker must
      // still be findable afterwards -- it is a permanent NDJSON line, not
      // incarnation-scoped, which is R6's actual property under test.
      await service.activate(sessionCase1.id, workerCase1.id);
      const handle3 = spawns.get('current');
      if (!handle3) bail('no fake subprocess handle recorded for the third activation');
      handle3.push(JSON.stringify({ v: 1, type: 'ready' }));
      await waitFor(async () => (await readEvents(sessionCase1.id, workerCase1.id, resolver1 as never)).some((e) => e.type === 'ready'), 2000, 'ready on the third activation');

      const infoThirdActivation = service.getRestoreInfo(workerCase1.id);
      check(
        infoThirdActivation !== null && infoThirdActivation.failed !== true,
        'the SECOND restore (third activation) SUCCEEDS -- the marker classifies as noise, not a blocking boundary',
        JSON.stringify(infoThirdActivation),
      );

      await service.deactivate(sessionCase1.id, workerCase1.id);
      const eventsAfterThird = await readEvents(sessionCase1.id, workerCase1.id, resolver1 as never);
      check(
        eventsAfterThird.some((e) => e.type === 'restore-failure-declaration'),
        'the declaration is STILL PRESENT after the second restore completes -- it outlives the incarnation that wrote it',
      );
    }

    // ====================================================================
    // CASE 2 -- NEGATIVE CONTROL: openai-api engine.
    // ====================================================================
    if (!EXPECT_NO_DECLARATION) {
      console.log('\n==> CASE 2: NEGATIVE CONTROL -- openai-api engine writes no declaration');
      await establishIncarnation(sessionCase2.id, workerCase2.id, resolver2 as never, 'openai-api');
      const liveOutputPath2 = await forceFallback(sessionCase2.id, workerCase2.id, resolver2 as never);
      await deactivateAfterFallback(sessionCase2.id, workerCase2.id);
      chmodSync(liveOutputPath2, 0o644);
      const freshContent2 = readFileSync(liveOutputPath2, 'utf-8').trim();
      check(freshContent2 === '', 'openai-api fallback leaves the fresh live file EMPTY (Loss is already symmetric and already declared by the failure form)', JSON.stringify(freshContent2));

      // ==================================================================
      // CASE 3 -- NEGATIVE CONTROL: claude-sdk with a NULL sdkSessionId.
      // ==================================================================
      console.log('\n==> CASE 3: NEGATIVE CONTROL -- claude-sdk with sdkSessionId still null writes no declaration');
      // Deliberately no sdk-session-id line: this incarnation never learns one.
      await service.activate(sessionCase3.id, workerCase3.id);
      const handleCase3 = spawns.get('current');
      if (!handleCase3) bail('no fake subprocess handle recorded for case 3\'s first activation');
      handleCase3.push(JSON.stringify({ v: 1, type: 'ready' }));
      await waitFor(async () => (await readEvents(sessionCase3.id, workerCase3.id, resolver3 as never)).some((e) => e.type === 'ready'), 2000, 'ready for case 3');
      await service.deactivate(sessionCase3.id, workerCase3.id);
      check(internalWorker3.sdkSessionId === null, 'PREMISE: sdkSessionId genuinely never got set for this worker', `sdkSessionId=${internalWorker3.sdkSessionId}`);

      const liveOutputPath3 = await forceFallback(sessionCase3.id, workerCase3.id, resolver3 as never);
      await deactivateAfterFallback(sessionCase3.id, workerCase3.id);
      chmodSync(liveOutputPath3, 0o644);
      const freshContent3 = readFileSync(liveOutputPath3, 'utf-8').trim();
      check(freshContent3 === '', 'claude-sdk fallback with no surviving sdkSessionId leaves the fresh live file EMPTY (nothing survives the reset to declare)', JSON.stringify(freshContent3));
    } else {
      console.log('\n==> polarity mode: cases 2 and 3 are skipped (they assert the fixed behaviour\'s negative space, not the defect)');
    }
  } finally {
    if (!disposed) {
      disposed = true;
      try {
        await shutdownAppContext(ctx);
      } catch {
        // best effort
      }
    }
    try {
      rmSync(disposableHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  console.log(`\n==> ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof BailError) {
      console.error(`\nCOULD NOT RUN: ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    console.error('\nCOULD NOT RUN: the smoke threw before it could finish');
    process.exit(2);
  });
}
