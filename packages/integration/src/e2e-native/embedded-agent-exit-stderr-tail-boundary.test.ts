/**
 * Client-Server Boundary Test: the `stderrTail` field on the persisted
 * `exited` embedded-agent event (Issue #1454, CLAUDE.md Q10).
 *
 * Issue #1454 added `stderrTail?: string` to the `exited` event, a shared
 * type that crosses the server -> client wire. As with `reason` (#1412, see
 * the sibling `embedded-agent-eviction-exit-reason-boundary.test.ts`), the
 * TypeScript type and the matching valibot schema are two independent
 * writers, and nothing forces them to move together. A field added to the
 * type but not to the schema is silently dropped -- or, since the `exited`
 * member is a `v.strictObject`, the WHOLE row is rejected -- while server
 * unit tests (which never cross the schema boundary) and any future client
 * store test (which would inject a pre-built mock object) both stay green.
 *
 * So this test drives the whole path in ONE run:
 *
 *   a real `EmbeddedAgentWorkerService` runs a real `claude-sdk` incarnation
 *   that writes stderr and then dies UNEXPECTEDLY (not via `deactivate`,
 *   which would produce `reason: 'managed'` and never attach a tail at all)
 *     -> the server appends the `exited` row through the real
 *        `WorkerOutputFileManager`
 *     -> the row is flushed to the file and read back through the real
 *        replay path (`readHistoryWithOffset`, what
 *        `SessionManager.getWorkerOutputHistory` ultimately serves to a
 *        reconnecting client)
 *     -> the read-back line is parsed with the REAL
 *        `EmbeddedAgentStreamEventSchema` from `@agent-console/shared`
 *     -> and the parsed value still carries `stderrTail`.
 *
 * The parse is the point. Reading `.stderrTail` off a `JSON.parse` result
 * would bypass precisely the layer that silently drops (or, here, rejects)
 * fields and make this test vacuous.
 *
 * The subprocess spawn is injected (`spawnAsUserFn`): the real Claude SDK is
 * not invoked, so activation, `ready`, stderr, and the unexpected exit are
 * driven deterministically. Everything between the server's append and the
 * schema's parse is production code.
 *
 * WHY THIS FILE LIVES UNDER `e2e-native/`: it needs pristine platform
 * natives. The injected subprocess hands the service a real `ReadableStream`
 * that the production stderr reader consumes with a real `TextDecoder`;
 * happy-dom's `GlobalRegistrator` (registered by `../setup.ts` for this
 * package's DOM boundary tests) replaces exactly that class of globals. No
 * DOM is involved anywhere in this test, so the DOM-free invocation is both
 * the safer and the cheaper home -- same reasoning as this directory's
 * sibling files.
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

const READY_LINE = '{"v":1,"type":"ready"}\n';
const BASE_DIR = '/test/config/repositories/test-repo';
const STDERR_LINE_1 = 'Error: boom in the tool call\n';
const STDERR_LINE_2 = '    at somewhere.ts:12:3\n';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded wait: a regression (the tail never attached, so `worker.subprocess`
 * never clears the way the test expects, or the row never appears) must FAIL
 * here rather than hang the suite.
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
  pushStderr: (s: string) => void;
  simulateCrash: (code: number) => void;
}

/**
 * A fake `spawnAsUser` standing in for the loop subprocess: real streams, real
 * `exited` promise. Unlike the eviction-boundary sibling's fake, this one's
 * stdin does NOT auto-exit on `shutdown` -- the scenario under test is an
 * UNEXPECTED crash, driven explicitly via `simulateCrash`, never a managed
 * shutdown.
 */
function makeFakeSpawn(): FakeSpawn {
  let count = 0;
  let latestPushStdout: (s: string) => void = () => {};
  let latestPushStderr: (s: string) => void = () => {};
  let latestSimulateExit: (code: number) => void = () => {};

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
      write: (_chunk: string | Uint8Array) => 0,
      end: () => {},
      flush: () => 0,
    };

    latestPushStdout = (s: string) => {
      if (!exited) stdoutCtrl.enqueue(encoder.encode(s));
    };
    latestPushStderr = (s: string) => {
      if (!exited) stderrCtrl.enqueue(encoder.encode(s));
    };
    latestSimulateExit = simulateExit;

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

  return {
    fn,
    spawnCount: () => count,
    pushStdout: (s) => latestPushStdout(s),
    pushStderr: (s) => latestPushStderr(s),
    simulateCrash: (code) => latestSimulateExit(code),
  };
}

describe('Client-Server Boundary: exited.stderrTail survives to the client (#1454)', () => {
  let service: EmbeddedAgentWorkerService | undefined;
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
        // best-effort: the worker is normally already exited by now
      }
    }
    service = undefined;
    sessionId = undefined;
    workerId = undefined;
    try {
      await cleanupTestEnvironment();
    } catch {
      // best-effort
    }
  });

  it(
    'a real unexpected exit with stderr appends an `exited` row that the real EmbeddedAgentStreamEventSchema parses with stderrTail',
    async () => {
      const resolver = new SessionDataPathResolver(BASE_DIR);
      // `flushThreshold: 1` makes every append hit the file immediately, so
      // the read-back below comes off disk rather than out of the pending
      // buffer.
      const outputFileManager = new WorkerOutputFileManager({ flushThreshold: 1, flushInterval: 5 });

      const worker = buildInternalEmbeddedAgentWorker({
        id: 'w-crashed',
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
      });

      await service.activate(session.id, worker.id);
      expect(spawn.spawnCount()).toBe(1);

      spawn.pushStdout(READY_LINE);
      spawn.pushStderr(STDERR_LINE_1);
      spawn.pushStderr(STDERR_LINE_2);
      spawn.simulateCrash(1);

      await waitFor(() => worker.subprocess === null, 5_000, 'the unexpected exit to clear the subprocess handle');

      // Off the pending buffer and onto the file, then back through the real
      // replay path a reconnecting client is served from.
      await outputFileManager.forceFlush(session.id, worker.id);
      const history = await outputFileManager.readHistoryWithOffset(session.id, worker.id, resolver);

      const rawExitedLines = history.data
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'exited');

      // Server half: the row was actually written, and it carries the tail.
      // Asserted before the parse so a schema failure below cannot be
      // confused with the server never having produced `stderrTail` at all.
      expect(rawExitedLines).toHaveLength(1);
      expect(rawExitedLines[0].reason).toBe('unexpected');
      expect(rawExitedLines[0].stderrTail).toBe(STDERR_LINE_1 + STDERR_LINE_2);

      // Wire half, and the reason this test exists: the SAME row through the
      // real shared schema. A `stderrTail` missing from the schema is
      // rejected here (the `exited` member is a `v.strictObject`) instead of
      // reaching the client silently degraded.
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
      expect(parsed.output.reason).toBe('unexpected');
      expect(parsed.output.stderrTail).toBe(STDERR_LINE_1 + STDERR_LINE_2);
    },
    20_000,
  );
});
