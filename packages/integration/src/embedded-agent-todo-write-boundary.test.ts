/**
 * Cross-Package Boundary Test: embedded-agent `TodoWrite` wire round-trip
 * (Issue #1573).
 *
 * Exercises the real server path a `TodoWrite` tool-call/tool-result pair
 * takes end to end: activate a real `EmbeddedAgentWorkerService` (via
 * `SessionManager`, fake `spawnAsUserFn` standing in for the loop subprocess
 * -- the loop's own tool-execution logic is out of scope here, covered by
 * packages/embedded-agent's own `todo-write.ts` unit suite), simulate the
 * loop streaming a `TodoWrite` tool-call + tool-result over stdout exactly as
 * the real `openai-api` loop would after calling
 * `createTodoWriteTool().execute(...)`, read the persisted history back via
 * `SessionManager.getWorkerOutputHistory` (the same call the worker WS
 * route makes), and parse every line with the REAL
 * `EmbeddedAgentStreamEventSchema`.
 *
 * Unit tests on either side cannot catch a schema drop here: embedded-agent's
 * own suite never touches the server's persistence/WS layer, and the
 * server's schema tests never construct a real `TodoWrite` payload shaped the
 * way the loop actually emits one. valibot silently strips or rejects an
 * unexpected field/shape at the schema boundary with no compile-time error on
 * either side -- this test is the only layer that would catch a
 * `TodoWrite` args/result shape drifting away from what
 * `EmbeddedAgentStreamEventSchema` accepts.
 *
 * The plain-`'TodoWrite'` case above does not involve a React client (out of
 * reach for this test suite); the client-side "the store/TodoPanel consumes
 * a TodoWrite tool-call" pin for that name is added separately in
 * packages/client's own test suite (`embedded-agent-store.test.ts`), using
 * that package's own `MockWebSocket` harness -- mirroring the precedent set
 * by embedded-agent-display-history-rotation-boundary.test.ts's header
 * comment.
 *
 * A second case below closes a narrower, MCP-specific gap: the `claude-sdk`
 * arm serves `TodoWrite` through an in-process SDK MCP server under the
 * namespaced tool name `SDK_TODO_WRITE_TOOL_NAME`
 * (`'mcp__console__TodoWrite'`), and the panel's own name predicate that
 * recognizes that name is otherwise only pinned against hand-written literal
 * fixtures (`TodoPanel.test.tsx`), never against a value that actually
 * travelled through `EmbeddedAgentStreamEventSchema`. That case reuses this
 * file's own persistence/replay path, then imports the real
 * `findLatestTodos` from `TodoPanel.tsx` and derives the rendered list from
 * the schema-parsed event -- proving the MCP-served name end to end, not
 * only in the panel's own unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';

import { EmbeddedAgentStreamEventSchema, SDK_TODO_WRITE_TOOL_NAME, type EmbeddedAgentStreamEvent } from '@agent-console/shared';
import { findLatestTodos } from '@agent-console/client/src/components/workers/TodoPanel';
import type { EmbeddedAgentChatEntry } from '@agent-console/client/src/components/workers/embedded-agent-store';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

interface ControllableStream {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
}

function makeControllableStream(): ControllableStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  return { stream, push: (s: string) => ctrl.enqueue(enc.encode(s)) };
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  pushStdout: (s: string) => void;
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdout = makeControllableStream();
  const stderr = makeControllableStream();
  const exited = new Promise<number>(() => {
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: () => 0,
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 9999, exited, stdin, stdout: stdout.stream, stderr: stderr.stream, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, captured, pushStdout: stdout.push };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Parse every NDJSON line in `data` with the client's replay schema (the FULL union). */
function parseReplayLines(data: string): { events: EmbeddedAgentStreamEvent[]; parseFailures: string[] } {
  const events: EmbeddedAgentStreamEvent[] = [];
  const parseFailures: string[] = [];
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      parseFailures.push(line);
      continue;
    }
    const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, json);
    if (parsed.success) events.push(parsed.output);
    else parseFailures.push(line);
  }
  return { events, parseFailures };
}

describe('Client-Server Boundary: embedded-agent TodoWrite tool-call/tool-result round trip', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();
    fake = makeFakeSpawn();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      annotationService: new AnnotationService(),
      // Test seam: fake the loop subprocess so this boundary test exercises
      // the real persistence/replay machinery without spawning a real `bun`
      // process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('persists a TodoWrite tool-call + tool-result pair that round-trips through the real schema', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(24681, 'owner', '/home/owner');

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    await sessionManager.activateEmbeddedAgentWorker(session.id, workerId);
    expect(fake.captured.length).toBe(1);

    const todos = [
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ];
    const resultString = 'Todo list updated: 2 items (1 pending, 1 in progress, 0 completed)';

    // Simulate the real openai-api loop's event sequence around a TodoWrite
    // call: ready/active, the tool-call with the exact args shape
    // createTodoWriteTool() accepts, the tool-result with the exact string
    // createTodoWriteTool() would have returned, then idle.
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'ready' })}\n`);
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'active' })}\n`);
    fake.pushStdout(
      `${JSON.stringify({
        v: 1,
        type: 'tool-call',
        turnId: 't1',
        callId: 'c1',
        name: 'TodoWrite',
        args: { todos },
      })}\n`,
    );
    fake.pushStdout(
      `${JSON.stringify({
        v: 1,
        type: 'tool-result',
        turnId: 't1',
        callId: 'c1',
        ok: true,
        result: resultString,
      })}\n`,
    );
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'idle' })}\n`);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('tool-result');
    });

    const read = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(read).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(read!.data);
    expect(parseFailures).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['ready', 'state', 'tool-call', 'tool-result', 'state']);

    const toolCall = events.find((e): e is Extract<EmbeddedAgentStreamEvent, { type: 'tool-call' }> => e.type === 'tool-call');
    expect(toolCall).toBeDefined();
    expect(toolCall!.name).toBe('TodoWrite');
    // The wire round-trip preserves the unknown-typed `args` field's
    // structure byte-for-byte -- confirming EmbeddedAgentStreamEventSchema's
    // `tool-call.args` field (v.unknown() -- an unvalidated passthrough, see
    // packages/shared/src/schemas/embedded-agent.ts) does not silently
    // reshape or strip the TodoWrite payload in transit.
    expect(toolCall!.args).toEqual({ todos });

    const toolResult = events.find(
      (e): e is Extract<EmbeddedAgentStreamEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.ok).toBe(true);
    expect(toolResult!.result).toBe(resultString);
  });

  it('persists a claude-sdk MCP-served TodoWrite (mcp__console__TodoWrite) call that the real client matcher derives a list from', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(24682, 'owner2', '/home/owner2');

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'SDK agent', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const worker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    await sessionManager.activateEmbeddedAgentWorker(session.id, workerId);
    expect(fake.captured.length).toBe(1);

    const todos = [{ content: 'Ship SDK support', status: 'pending' as const, activeForm: 'Shipping SDK support' }];
    const resultString = 'Todo list updated: 1 item (1 pending, 0 in progress, 0 completed)';

    // Same event sequence shape as the plain-name case above, but the
    // tool-call carries the claude-sdk arm's MCP-namespaced name instead of
    // the openai-api builtin's plain 'TodoWrite'.
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'ready' })}\n`);
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'active' })}\n`);
    fake.pushStdout(
      `${JSON.stringify({
        v: 1,
        type: 'tool-call',
        turnId: 't1',
        callId: 'c1',
        name: SDK_TODO_WRITE_TOOL_NAME,
        args: { todos },
      })}\n`,
    );
    fake.pushStdout(
      `${JSON.stringify({
        v: 1,
        type: 'tool-result',
        turnId: 't1',
        callId: 'c1',
        ok: true,
        result: resultString,
      })}\n`,
    );
    fake.pushStdout(`${JSON.stringify({ v: 1, type: 'state', state: 'idle' })}\n`);

    await waitFor(async () => {
      const hist = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('tool-result');
    });

    const read = await sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(read).not.toBeNull();

    // (a) + (b): the persisted row parses through the real
    // EmbeddedAgentStreamEventSchema, and the MCP-namespaced name/args
    // round-trip byte-for-byte -- this is the same schema
    // embedded-agent-store.ts uses for its own replay parse, so this IS the
    // client's worker-stream parse path.
    const { events, parseFailures } = parseReplayLines(read!.data);
    expect(parseFailures).toEqual([]);

    const toolCall = events.find((e): e is Extract<EmbeddedAgentStreamEvent, { type: 'tool-call' }> => e.type === 'tool-call');
    expect(toolCall).toBeDefined();
    expect(toolCall!.name).toBe(SDK_TODO_WRITE_TOOL_NAME);
    expect(toolCall!.args).toEqual({ todos });

    const toolResult = events.find(
      (e): e is Extract<EmbeddedAgentStreamEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.ok).toBe(true);
    expect(toolResult!.result).toBe(resultString);

    // (c): the real client matcher, fed the schema-parsed values (not fresh
    // literals), derives the same list -- proving the MCP name end to end
    // through both the wire schema AND the panel's own matcher.
    const entries: EmbeddedAgentChatEntry[] = [
      {
        key: `tc-${toolCall!.callId}`,
        kind: 'tool-call',
        turnId: toolCall!.turnId,
        callId: toolCall!.callId,
        name: toolCall!.name,
        args: toolCall!.args,
        result: { ok: toolResult!.ok, result: toolResult!.result },
      },
    ];

    expect(findLatestTodos(entries)).toEqual(todos);
  });
});
