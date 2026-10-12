#!/usr/bin/env bun
/**
 * Shipping-path smoke for the bulk-restart `exited` row: after
 * `SessionManager.restartAllAgentWorkers({ kind: 'all' })` restarts two
 * embedded-agent workers, EACH worker's output history must contain the
 * `exited` row its previous incarnation's exit observer appended.
 *
 * FREE AND DETERMINISTIC. No real `claude` CLI, no OS subprocess, no billing.
 * The property is a pure filesystem/buffering property of the output history,
 * so a scripted stub subprocess driven through the REAL event handler is
 * sufficient. Modelled on `check-restore-failure-declaration.ts`.
 *
 * WHAT IS REAL: a real `AppContext` (`createTestContext`, real SQLite, real
 * disk-backed `WorkerOutputFileManager` under a disposable AGENT_CONSOLE_HOME),
 * real DB-backed sessions/workers, the real `restartAllAgentWorkers` (the same
 * method the MCP tool and REST route call), the real `deactivate` /
 * `activate` / restore path.
 *
 * WHAT IS FAKED: `spawnAsUserFn` returns an in-process stub subprocess. Each
 * stub auto-reports `ready` after `--ready-delay-ms`.
 *
 * SHAPE: worker A is given one scripted turn (it has a conversation to
 * restore); worker B stays silent. Then the bulk restart runs, and each
 * worker's history is polled (up to 5 s) for a row with `type: 'exited'`.
 *
 * Usage:
 *   bun scripts/smoke/check-bulk-restart-exited-row.ts
 *   bun scripts/smoke/check-bulk-restart-exited-row.ts --expect-lost
 *   bun scripts/smoke/check-bulk-restart-exited-row.ts --ready-delay-ms 150
 *   bun scripts/smoke/check-bulk-restart-exited-row.ts --help
 *
 * `--expect-lost` is the polarity mode: it asserts the defect (B's row never
 * appears) and reports a polarity failure when it does appear. Run it against
 * a scratch revert of the fix to confirm the apparatus reaches the defect.
 *
 * Exit codes: 0 all assertions of the selected mode passed; 1 an assertion
 * failed; 2 bad usage / could not run.
 */
import './_env.js';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSink, Subprocess } from 'bun';
import type { EmbeddedAgentStreamEvent } from '../../packages/shared/src/types/embedded-agent.ts';

export interface BulkRestartArgs {
  expectLost: boolean;
  readyDelayMs: number;
  engine: 'openai-api' | 'claude-sdk';
  exitDelayMs: number;
  lateBReady: boolean;
  realistic: boolean;
  help: boolean;
}

export const USAGE = `Usage: bun scripts/smoke/check-bulk-restart-exited-row.ts [--expect-lost] [--ready-delay-ms N] [--realistic] [--exit-delay-ms N] [--engine openai-api|claude-sdk] [--help]

  --expect-lost        polarity mode: assert the exited row is LOST for worker B (the pre-fix defect)
  --ready-delay-ms N   delay before each stub incarnation reports ready (default 0)
  --realistic          default flush interval; B's first incarnation reports ready only at its shutdown, so its whole first life falls inside one flush interval (timing control)
  --exit-delay-ms N    delay between kill and the stub's exit settling (default 0)
  --engine E           engine of the two workers (default openai-api)
  --help               print this text and exit 0`;

export function parseArgs(argv: string[]): BulkRestartArgs {
  const out: BulkRestartArgs = { expectLost: false, readyDelayMs: 0, engine: 'openai-api', exitDelayMs: 0, lateBReady: false, realistic: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--realistic') { out.realistic = true; out.lateBReady = true; if (out.exitDelayMs === 0) out.exitDelayMs = 20; }
    else if (a === '--expect-lost') out.expectLost = true;
    else if (a === '--exit-delay-ms') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--exit-delay-ms needs a non-negative number\n${USAGE}`);
      out.exitDelayMs = v;
    } else if (a === '--engine') {
      const v = argv[++i];
      if (v !== 'openai-api' && v !== 'claude-sdk') throw new Error(`--engine must be openai-api or claude-sdk\n${USAGE}`);
      out.engine = v;
    } else if (a === '--ready-delay-ms') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--ready-delay-ms needs a non-negative number\n${USAGE}`);
      out.readyDelayMs = v;
    } else throw new Error(`unrecognised argument: ${a}\n${USAGE}`);
  }
  return out;
}

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

class BailError extends Error {}
function bail(message: string): never {
  throw new BailError(message);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(20);
  }
  return false;
}

interface FakeHandle {
  push: (line: string) => void;
}

function makeFakeSubprocess(exitDelayMs: number, onShutdown?: (push: (line: string) => void) => void) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => { stderrController = c; } });
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
  let closed = false;
  const stdin = {
    write: (chunk: unknown) => {
      // A graceful harness exits on the `shutdown` command, as the real one does.
      if (typeof chunk === 'string' && chunk.includes('"shutdown"')) {
        onShutdown?.((line) => controller.enqueue(enc.encode(`${line}\n`)));
        setTimeout(() => settle(0), exitDelayMs);
      }
      return 0;
    },
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
    kill: (_signal?: number) => { if (exitDelayMs > 0) setTimeout(() => settle(0), exitDelayMs); else settle(0); },
  } as unknown as Subprocess<'pipe', 'pipe', 'pipe'>;
  const handle: FakeHandle = { push: (line) => controller.enqueue(enc.encode(`${line}\n`)) };
  return { subprocess, stdin, handle };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  console.log(`==> mode: ${args.expectLost ? 'POLARITY (--expect-lost: the defect must reproduce)' : 'FIX (every worker keeps its exited row)'}`);

  const disposableHome = path.join(os.tmpdir(), `agent-console-bulk-exit-${process.pid}-${Date.now()}`);
  const cwd = path.join(disposableHome, 'work');
  mkdirSync(cwd, { recursive: true });
  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'none';
  // Deterministic by default: the first life's output is guaranteed still pending at the restart.
  if (!args.realistic) process.env.WORKER_OUTPUT_FLUSH_INTERVAL = '60000';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.ts');

  const spawns: FakeHandle[] = [];
  const spawnAsUserFn = () => {
    const { subprocess, stdin, handle } = makeFakeSubprocess(args.exitDelayMs, spawns.length === 1 && args.lateBReady ? (push) => push(JSON.stringify({ v: 1, type: 'ready' })) : undefined);
    spawns.push(handle);
    const ready = JSON.stringify({ v: 1, type: 'ready' });
    // B's FIRST incarnation (spawn index 1) reports ready only when the bulk
    // restart sends it `shutdown`, so every row it ever wrote -- its `exited`
    // row included -- is buffered within one flush interval and unflushed
    // when B's second incarnation activates.
    if (spawns.length === 2 && args.lateBReady) return { subprocess, stdin, elevated: false };
    setTimeout(() => handle.push(ready), args.readyDelayMs);
    return { subprocess, stdin, elevated: false };
  };

  const ctx = await createTestContext({ spawnAsUserFn: spawnAsUserFn as never, getMcpBaseUrl: () => 'http://127.0.0.1:1/mcp' });
  try {
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser?.id) bail('no authenticated user');
    const { CLAUDE_SDK_AGENT_ID } = await import('../../packages/server/src/services/embedded-agents/claude-sdk-builtin.ts');
    const defId = args.engine === 'claude-sdk'
      ? CLAUDE_SDK_AGENT_ID
      : (await ctx.embeddedAgentManager.createEmbeddedAgent(
          { name: 'bulk-restart smoke', engine: 'openai-api', provider: { baseUrl: 'http://127.0.0.1:1/v1', model: 'unused' } },
          authUser.id,
        )).id;
    const mk = async () => {
      const session = await ctx.sessionManager.createSession({ type: 'quick', locationPath: cwd }, { createdBy: authUser.id });
      const worker = await ctx.sessionManager.createWorker(session.id, { type: 'embedded-agent', embeddedAgentId: defId });
      if (!worker) bail('createWorker returned null');
      const resolver = ctx.sessionManager.getPathResolverForSessionId(session.id);
      if (!resolver) bail('no path resolver');
      return { sessionId: session.id, workerId: worker.id, resolver };
    };
    const A = await mk();
    const B = await mk();

    const wofm = ctx.workerOutputFileManager;
    const readEvents = async (w: typeof A): Promise<EmbeddedAgentStreamEvent[]> => {
      const hist = await wofm.readHistoryWithOffset(w.sessionId, w.workerId, w.resolver);
      const events: EmbeddedAgentStreamEvent[] = [];
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try { events.push(JSON.parse(line) as EmbeddedAgentStreamEvent); } catch { /* tolerated */ }
      }
      return events;
    };
    const countExited = async (w: typeof A) => (await readEvents(w)).filter((e) => e.type === 'exited').length;

    await ctx.sessionManager.activateEmbeddedAgentWorker(A.sessionId, A.workerId);
    await ctx.sessionManager.activateEmbeddedAgentWorker(B.sessionId, B.workerId);
    if (spawns.length !== 2) bail(`expected 2 spawns after activating A and B, saw ${spawns.length}`);
    for (const w of args.lateBReady ? [A] : [A, B]) {
      if (!(await waitFor(async () => (await readEvents(w)).some((e) => e.type === 'ready'), 3000))) bail('initial ready never persisted');
    }

    // A gets one scripted turn; B stays silent.
    const send = await ctx.sessionManager.sendEmbeddedAgentUserMessage(A.sessionId, A.workerId, 'hello (bulk-restart smoke)');
    if (!send.ok || !('id' in send)) bail(`sendUserMessage refused or queued: ${JSON.stringify(send)}`);
    spawns[0].push(JSON.stringify({ v: 1, type: 'assistant-message', turnId: send.id, text: 'hi' }));
    spawns[0].push(JSON.stringify({ v: 1, type: 'state', state: 'idle' }));
    if (args.engine === 'claude-sdk') spawns[0].push(JSON.stringify({ v: 1, type: 'sdk-session-id', sdkSessionId: `sess-bulk-${A.workerId}` }));
    const settled = await waitFor(
      async () => (await readEvents(A)).some((e) => e.type === 'state' && (e as { state?: string }).state === 'idle'),
      3000,
    );
    if (!settled) bail('the scripted turn on A never settled idle');

    const result = await ctx.sessionManager.restartAllAgentWorkers({ kind: 'all' });
    console.log(`  restart results: ${JSON.stringify(result.results.map((r) => ({ w: r.workerId.slice(0, 8), t: r.workerType, o: r.outcome })))}`);
    console.log(`  A=${A.workerId.slice(0, 8)} B=${B.workerId.slice(0, 8)}`);
    const embeddedRestarted = result.results.filter((r) => r.workerType === 'embedded-agent' && r.outcome === 'restarted' && (r.workerId === A.workerId || r.workerId === B.workerId)).length;
    check(embeddedRestarted === 2, 'the bulk restart restarted both embedded workers', `embeddedRestarted=${embeddedRestarted} failed=${result.failed}`);
    if (spawns.length !== 4) bail(`expected 4 spawns after the bulk restart, saw ${spawns.length}`);

    // --realistic keeps the default flush interval, so whether A's first life is
    // still pending is a race; only B (whose first life is pinned inside one
    // flush interval) is asserted there.
    for (const [label, w] of (args.realistic ? [['B', B]] : [['A', A], ['B', B]]) as Array<['A' | 'B', typeof A]>) {
      const found = await waitFor(async () => (await countExited(w)) > 0, 5000);
      const n = await countExited(w);
      if (args.expectLost) {
        check(!found, `POLARITY: ${label} has no exited row in its history -- the defect reproduces`, `exited rows=${n}`);
      } else {
        check(found, `${label} has its exited row after the bulk restart`, `exited rows=${n}`);
      }
    }
  } finally {
    try { await shutdownAppContext(ctx); } catch { /* best effort */ }
    try { rmSync(disposableHome, { recursive: true, force: true }); } catch { /* best effort */ }
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
