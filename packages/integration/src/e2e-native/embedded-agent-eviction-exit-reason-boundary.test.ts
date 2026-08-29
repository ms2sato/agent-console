/**
 * Client-Server Boundary Test: the `reason` field on the persisted `exited`
 * embedded-agent event (idle eviction, #1412, CLAUDE.md Q10).
 *
 * Idle eviction added `reason?: ExitReason` -- and the new value `'evicted'`
 * -- to the `exited` event, a shared type that crosses the server -> client
 * wire. Both halves are already pinned SEPARATELY: a server unit test asserts
 * the appended JSON line
 * (packages/server/src/services/__tests__/embedded-agent-idle-eviction-service.test.ts)
 * and a client store test asserts the fold after parse. Nothing joins them,
 * and the join is exactly where this repository has been burned before: a
 * field added to the TypeScript type but not to the matching valibot schema
 * is dropped (or, with `v.strictObject`, rejected) at the boundary while both
 * sides' unit tests stay green, because each injects its own mock object and
 * neither traverses the parse.
 *
 * So this test drives the whole path in ONE run:
 *
 *   a real `EmbeddedAgentWorkerService` idle-evicts a real `claude-sdk`
 *   worker (driven by the real countdown, not by a `deactivate` call --
 *   deactivating would produce `'managed'` and prove nothing about the value
 *   under test)
 *     -> the server appends the `exited` row through the real
 *        `WorkerOutputFileManager`
 *     -> the row is flushed to the file and read back through the real
 *        replay path (`readHistoryWithOffset`, what
 *        `SessionManager.getWorkerOutputHistory` ultimately serves to a
 *        reconnecting client)
 *     -> the read-back line is parsed with the REAL
 *        `EmbeddedAgentStreamEventSchema` from `@agent-console/shared`
 *     -> and the parsed value still carries `reason: 'evicted'`.
 *
 * The parse is the point. Reading `.reason` off a `JSON.parse` result would
 * bypass precisely the layer that silently drops fields and make this test
 * vacuous.
 *
 * The subprocess spawn is injected (`spawnAsUserFn`): the real Claude SDK is
 * not invoked, so activation, `ready`, and exit are driven deterministically.
 * Everything between the server's append and the schema's parse is production
 * code.
 *
 * WHY THIS FILE LIVES UNDER `e2e-native/`: it needs pristine platform natives.
 * The injected subprocess hands the service a real `ReadableStream` that the
 * production stdout reader consumes with a real `TextDecoder`; happy-dom's
 * `GlobalRegistrator` (registered by `../setup.ts` for this package's DOM
 * boundary tests) replaces exactly that class of globals. No DOM is involved
 * anywhere in this test, so the DOM-free invocation is both the safer and the
 * cheaper home -- same reasoning as this directory's sibling files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import {
  buildInternalEmbeddedAgentWorker,
  buildInternalWorktreeSession,
} from '@agent-console/server/src/__tests__/utils/build-test-data';
import { EmbeddedAgentWorkerService } from '@agent-console/server/src/services/embedded-agent-worker-service';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionDataPathResolver } from '@agent-console/server/src/lib/session-data-path-resolver';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import {
  claudeSdkAgent,
  CLAUDE_SDK_AGENT_ID,
} from '@agent-console/server/src/services/embedded-agents/claude-sdk-builtin';
import type {
  SpawnAsUserFn,
  SpawnAsUserResult,
} from '@agent-console/server/src/services/privilege-elevation';

import { EmbeddedAgentStreamEventSchema } from '@agent-console/shared';

/** Threshold small enough that the real countdown fires on its own, fast. */
const IDLE_EVICTION_MS = 15;
const READY_LINE = '{"v":1,"type":"ready"}\n';
const BASE_DIR = '/test/config/repositories/test-repo';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded wait: a regression (no eviction, so no `exited` row) must FAIL here
 * rather than hang the suite.
 */
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(5);
  }
}

interface FakeSpawn {
  fn: SpawnAsUserFn;
  spawnCount: () => number;
  pushStdout: (s: string) => void;
}

/**
 * A fake `spawnAsUser` standing in for the loop subprocess: real streams, real
 * `exited` promise, and a stdin that exits on the production `shutdown`
 * command the way a well-behaved loop does.
 */
function makeFakeSpawn(): FakeSpawn {
  let count = 0;
  let latestPush: (s: string) => void = () => {};

  const fn: SpawnAsUserFn = () => {
    count += 1;
    let exited = false;
    let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutCtrl = c;
      },
    });
    let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrCtrl = c;
      },
    });
    const encoder = new TextEncoder();

    let resolveExited!: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const simulateExit = (code: number): void => {
      if (exited) return;
      exited = true;
      resolveExited(code);
      stdoutCtrl.close();
      stderrCtrl.close();
    };

    const stdin = {
      write: (chunk: string | Uint8Array) => {
        const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        if (s.includes('"type":"shutdown"')) simulateExit(0);
        return 0;
      },
      end: () => {},
      flush: () => 0,
    };

    latestPush = (s: string) => {
      if (!exited) stdoutCtrl.enqueue(encoder.encode(s));
    };

    const subprocess = {
      pid: 9000 + count,
      exited: exitedPromise,
      stdin,
      stdout,
      stderr,
      kill: () => simulateExit(137),
    };

    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };

  return { fn, spawnCount: () => count, pushStdout: (s) => latestPush(s) };
}

describe('Client-Server Boundary: exited.reason survives to the client as `evicted` (#1412)', () => {
  let service: EmbeddedAgentWorkerService | undefined;
  let outputFileManager: WorkerOutputFileManager | undefined;
  let sessionId: string | undefined;
  let workerId: string | undefined;

  beforeEach(async () => {
    await setupTestEnvironment();
  });

  afterEach(async () => {
    if (service && sessionId && workerId) {
      try {
        await service.deactivate(sessionId, workerId);
      } catch {
        // best-effort: the worker is normally already evicted by now
      }
    }
    service = undefined;
    outputFileManager = undefined;
    sessionId = undefined;
    workerId = undefined;
    try {
      await cleanupTestEnvironment();
    } catch {
      // best-effort
    }
  });

  it(
    'a real idle eviction appends an `exited` row that the real EmbeddedAgentStreamEventSchema parses with reason === "evicted"',
    async () => {
      const resolver = new SessionDataPathResolver(BASE_DIR);
      // `flushThreshold: 1` makes every append hit the file immediately, so the
      // read-back below comes off disk rather than out of the pending buffer.
      outputFileManager = new WorkerOutputFileManager({ flushThreshold: 1, flushInterval: 5 });

      const worker = buildInternalEmbeddedAgentWorker({
        id: 'w-evicted',
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      });
      const session = buildInternalWorktreeSession([worker], { createdBy: 'test-user-id' });
      sessionId = session.id;
      workerId = worker.id;

      const spawn = makeFakeSpawn();
      service = new EmbeddedAgentWorkerService({
        getSession: (id) => (id === session.id ? session : undefined),
        persistSession: async () => {},
        getPathResolver: () => resolver,
        // The REAL built-in definition: eviction is gated to `claude-sdk`, so
        // the engine value is load-bearing for this test even reaching the
        // value under test.
        getEmbeddedAgent: (id) => (id === CLAUDE_SDK_AGENT_ID ? claudeSdkAgent : undefined),
        resolveSpawnUsername: async () => 'testuser',
        mcpTokenRegistry: new McpTokenRegistry(),
        workerOutputFileManager: outputFileManager,
        getMcpBaseUrl: () => 'http://localhost:3457/mcp',
        spawnAsUserFn: spawn.fn,
        entryPath: '/install/embedded-agent/src/main.ts',
        getGlobalActivityCallback: () => undefined,
        getGlobalWorkerExitCallback: () => undefined,
        shutdownGraceMs: 200,
        sigtermTimeoutMs: 200,
        idleEvictionMs: IDLE_EVICTION_MS,
      });

      await service.activate(session.id, worker.id);
      expect(spawn.spawnCount()).toBe(1);
      expect(claudeSdkAgent.engine).toBe('claude-sdk');

      // The countdown only arms once the worker reports `ready`. Without this
      // line nothing is ever evicted.
      spawn.pushStdout(READY_LINE);

      await waitFor(() => worker.subprocess === null, 5_000, 'the idle eviction to drop the subprocess');

      // Off the pending buffer and onto the file, then back through the real
      // replay path a reconnecting client is served from.
      await outputFileManager.forceFlush(session.id, worker.id);
      const history = await outputFileManager.readHistoryWithOffset(session.id, worker.id, resolver);

      const rawExitedLines = history.data
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'exited');

      // Server half: the row was actually written, and it carries the value.
      // Asserted before the parse so a schema failure below cannot be confused
      // with the server never having produced `reason` at all.
      expect(rawExitedLines).toHaveLength(1);
      expect(rawExitedLines[0].reason).toBe('evicted');

      // Wire half, and the reason this test exists: the SAME row through the
      // real shared schema. A `reason` missing from the schema is rejected
      // here (the `exited` member is a `v.strictObject`) instead of reaching
      // the client silently degraded.
      const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, rawExitedLines[0]);
      if (!parsed.success) {
        throw new Error(
          `EmbeddedAgentStreamEventSchema rejected the persisted exited row: ${JSON.stringify(
            parsed.issues.map((i) => i.message),
          )} -- row was ${JSON.stringify(rawExitedLines[0])}`,
        );
      }
      expect(parsed.output.type).toBe('exited');
      if (parsed.output.type !== 'exited') throw new Error('unreachable: asserted above');
      expect(parsed.output.reason).toBe('evicted');
    },
    20_000,
  );
});
