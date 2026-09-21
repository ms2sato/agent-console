/**
 * Client-Server Boundary Test: MCP server permission wire (epic #1636 Phase 5
 * PR-2, docs/design/embedded-agent-sdk-engine.md §4.5's "the approval
 * record"), Architect ruling (B), 2026-09-21: `McpServerWireConfig` never
 * crosses the wire -- both `init.allowedProjectMcpServers` and the
 * `set-mcp-servers` command carry ONLY `Array<{ name; hash }>` pairs.
 *
 * Per pre-pr-completeness.md Q10, a shared-type field/command crossing the
 * server/client (here: server/subprocess AND server/client-app) wire needs an
 * integration test exercising the REAL chain end to end -- a schema unit test
 * never touches the wire boundary, and a route/service unit test mocks its
 * collaborators and never reaches a real subprocess stdin/stdout pipe.
 *
 * This test drives the real chain:
 *
 *   1. `init.allowedProjectMcpServers` -- written to the fake subprocess's
 *      stdin at real activation, re-parsed through the REAL
 *      `EmbeddedAgentCommandSchema` (the exact parser `main.ts` uses).
 *   2. `mcp-servers-discovered` / `mcp-servers-applied` events -- fed back
 *      through the fake subprocess's stdout, re-parsed through the REAL
 *      `EmbeddedAgentEventSchema`, and (for the discovered event) landing on
 *      the real, PUBLIC `Worker.mcpServers` field, which is then round-tripped
 *      through the REAL `AppServerMessageSchema` the same way the app
 *      WebSocket's `session-updated` broadcast would carry it to a client.
 *   3. The REST permission round trip: a real `POST .../mcp-permissions`
 *      writes a `set-mcp-servers` command to the fake subprocess's stdin --
 *      asserted to carry (name, hash) PAIRS ONLY, never a server config -- and
 *      the route's response reflects the recorded decision.
 *   4. A `strictObject` reject test for the STALE full-config payload shape
 *      (Q10's failure mode: a dropped frame with only a browser-console log,
 *      never a thrown error visible to a test that does not check `.success`).
 *   5. (epic #1636 Phase 5 PR-3b, Orchestrator disposition on the preflight
 *      integration-coverage warning raised against `SessionPage.tsx` /
 *      `EmbeddedAgentWorkerView.tsx`) The CONSUMER half of forms (a)/(b):
 *      `mcp-servers-discovered.mcpJsonError` and `mcp-servers-applied.reason`
 *      driven through the real loop-stdout -> `WorkerOutputFileManager`
 *      persistence -> `SessionManager.getWorkerOutputHistory` replay path,
 *      then fed -- as the exact persisted bytes, not a hand-typed literal --
 *      into the REAL CLIENT STORE (`embedded-agent-store.ts`) via a
 *      simulated worker-WS `history` push, the same code
 *      `useEmbeddedAgentWorker` reads. The store's own `foldLine()` calls
 *      the REAL `EmbeddedAgentStreamEventSchema` internally, so this is the
 *      client's actual replay-parse path, not a second hand-authored parse.
 *      PR-3b's own view tests (`EmbeddedAgentWorkerView.test.tsx`) inject a
 *      `mcp-servers-discovered`/`mcp-servers-applied` frame via the mock WS
 *      directly, as a literal object -- they pin the RENDERING but cannot
 *      pin the wire-to-store PARSE step, which is exactly the pre-pr-
 *      completeness.md Q10 step 2 gap this case closes.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  getTestConfigDir,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { CLAUDE_SDK_AGENT_ID } from '@agent-console/server/src/services/embedded-agent-manager';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

import {
  EmbeddedAgentCommandSchema,
  EmbeddedAgentEventSchema,
  AppServerMessageSchema,
  type AppServerMessage,
} from '@agent-console/shared';
import { getOrCreateEmbeddedAgentWorker, _resetEmbeddedAgentWorkers } from '@agent-console/client/src/components/workers/embedded-agent-store';
import { MockWebSocket, installMockWebSocket } from '@agent-console/client/src/test/mock-websocket';

const TEST_REPO_PATH = '/test/mcp-permission-repo';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
  pushStdoutLine: (line: object) => void;
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 31337, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return {
    fn,
    captured,
    stdinWrites,
    pushStdoutLine: (line: object) => {
      if (!stdoutController) throw new Error('stdout controller not initialized');
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('Client-Server Boundary: MCP server permission wire (epic #1636 Phase 5 PR-2, Architect ruling B)', () => {
  let ctx: AppContext;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let capturedBroadcasts: AppServerMessage[];

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    fake = makeFakeSpawn();
    capturedBroadcasts = [];
    ctx = await createTestContext({
      spawnAsUserFn: fake.fn,
      broadcastToApp: (msg) => {
        capturedBroadcasts.push(msg);
      },
    });
    // Mirrors websocket/routes.ts's production `onSessionUpdated ->
    // broadcastToApp({ type: 'session-updated', session })` wiring (
    // setupWebSocketRoutes), which createTestContext() alone does not
    // register (same pattern as session-memo-boundary.test.ts's
    // onMemoUpdated wiring).
    ctx.sessionManager.setSessionLifecycleCallbacks({
      onSessionUpdated: (session) => {
        ctx.broadcastToApp({ type: 'session-updated', session });
      },
    });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function createSdkWorktreeWorker() {
    const owner = await ctx.userRepository.upsertByOsUid(13579, 'mcp-perm-owner', '/home/mcp-perm-owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: CLAUDE_SDK_AGENT_ID,
    });
    expect(worker).not.toBeNull();
    return { owner, repository, sessionId: session.id, workerId: worker!.id };
  }

  it('init.allowedProjectMcpServers is written as (name, hash) pairs and parses through the REAL EmbeddedAgentCommandSchema', async () => {
    const { sessionId, workerId } = await createSdkWorktreeWorker();

    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    const initRaw = JSON.parse(fake.stdinWrites[0]);
    const parsed = v.safeParse(EmbeddedAgentCommandSchema, initRaw);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.output.type === 'init' && parsed.output.engine === 'claude-sdk') {
      // Empty: no permission rows recorded yet for this repository. The
      // field must still be PRESENT (required, never omitted) -- see the
      // schema's own doc comment.
      expect(parsed.output.allowedProjectMcpServers).toEqual([]);
    } else {
      throw new Error('expected a claude-sdk init command');
    }
  });

  it('mcp-servers-discovered parses through EmbeddedAgentEventSchema and lands in Worker.mcpServers, which round-trips through AppServerMessageSchema (the app WS session-updated shape)', async () => {
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    const discoveredEvent = {
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' }],
    };
    const parsedEvent = v.safeParse(EmbeddedAgentEventSchema, discoveredEvent);
    expect(parsedEvent.success).toBe(true);

    fake.pushStdoutLine(discoveredEvent);
    await waitFor(() => {
      const w = ctx.sessionManager.getSession(sessionId)?.workers.find((x) => x.id === workerId);
      return w?.type === 'embedded-agent' && w.mcpServers !== undefined;
    });

    const session = ctx.sessionManager.getSession(sessionId)!;
    const worker = session.workers.find((w) => w.id === workerId)!;
    expect(worker.type === 'embedded-agent' && worker.mcpServers).toEqual([
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);

    // The exact shape packages/server/src/websocket/routes.ts broadcasts on a
    // session-updated event. A stashed `mcpServers` field on
    // `EmbeddedAgentWorkerSchema` would make this safeParse strip the field
    // (or, post-#927, reject the whole message) silently -- see the app
    // WebSocket's own `parseMessage`.
    const wireMessage = { type: 'session-updated' as const, session };
    const parsedWire = v.safeParse(AppServerMessageSchema, wireMessage);
    expect(parsedWire.success).toBe(true);
    if (parsedWire.success && parsedWire.output.type === 'session-updated') {
      const wireWorker = parsedWire.output.session.workers.find((w) => w.id === workerId);
      expect(wireWorker?.type === 'embedded-agent' && wireWorker.mcpServers).toEqual([
        { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
      ]);
    }
  });

  it('a real mcp-servers-discovered event makes the server actually call broadcastToApp with a session-updated frame (not merely a hand-built shape check)', async () => {
    // The test above proves the WIRE SHAPE survives `AppServerMessageSchema`
    // once a `session-updated` payload is hand-constructed. It does not
    // prove the server ever produces that payload as a consequence of a
    // discovered event -- worker.mcpServers could change in memory with no
    // app client ever being told. This test drives the real
    // onSessionUpdated -> broadcastToApp wiring (mirrored from
    // websocket/routes.ts's production setupWebSocketRoutes, same pattern
    // as session-memo-boundary.test.ts) and asserts the broadcast actually
    // fires.
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    // Activation itself already broadcasts once; isolate the discovered
    // event's own broadcast from activation's.
    capturedBroadcasts.length = 0;

    const discoveredEvent = {
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' }],
    };
    fake.pushStdoutLine(discoveredEvent);

    // Waits for the broadcast itself, not merely for worker.mcpServers to
    // change in memory -- the exact gap this test exists to close.
    await waitFor(() => capturedBroadcasts.some((m) => m.type === 'session-updated'));

    const sessionUpdatedBroadcasts = capturedBroadcasts.filter((m) => m.type === 'session-updated');
    expect(sessionUpdatedBroadcasts).toHaveLength(1);

    const wirePayload = JSON.parse(JSON.stringify(sessionUpdatedBroadcasts[0]));
    const parsedWire = v.safeParse(AppServerMessageSchema, wirePayload);
    expect(parsedWire.success).toBe(true);
    if (!parsedWire.success) {
      throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsedWire.issues.map((i) => i.message))}`);
    }
    if (parsedWire.output.type !== 'session-updated') {
      throw new Error(`Expected session-updated, got: ${parsedWire.output.type}`);
    }

    const wireWorker = parsedWire.output.session.workers.find((w) => w.id === workerId);
    expect(wireWorker?.type === 'embedded-agent' && wireWorker.mcpServers).toEqual([
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' },
    ]);
  });

  it('mcp-servers-applied parses through EmbeddedAgentEventSchema', async () => {
    const appliedEvent = { v: 1, type: 'mcp-servers-applied', applied: true };
    const parsed = v.safeParse(EmbeddedAgentEventSchema, appliedEvent);
    expect(parsed.success).toBe(true);
  });

  it('a form (b)-shaped event (reserved only, no hash/decision) after form (a) does not erase the discovered pair -- the REST route still finds it (regression lock)', async () => {
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    // Form (a): activation-time discovery.
    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' }],
    });
    await waitFor(() => {
      const w = ctx.sessionManager.getSession(sessionId)?.workers.find((x) => x.id === workerId);
      return w?.type === 'embedded-agent' && w.mcpServers !== undefined;
    });

    // Form (b)-shaped: a `system:init` occurrence reporting ONLY the
    // reserved server -- never carrying hash/decision on ANY entry,
    // project-scope included (see `emitMcpServersDiscovered`'s own doc
    // comment). Before the server-side merge fix, this REPLACED
    // `worker.mcpServers` wholesale, silently dropping chrome-devtools's
    // discovered (name, hash) pair.
    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'agent-console', scope: 'reserved' }],
    });
    await waitFor(() => {
      const w = ctx.sessionManager.getSession(sessionId)?.workers.find((x) => x.id === workerId);
      return w?.type === 'embedded-agent' && (w.mcpServers ?? []).some((entry) => entry.name === 'agent-console');
    });

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}/mcp-permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' }),
    });

    // The regression lock: the route must still FIND the pair (200), not
    // 404 with resolvePermissionDecisions's not-discovered text.
    //
    // Polarity confirmed: temporarily reverting the (e2) handler in
    // embedded-agent-worker-service.ts to its pre-fix plain
    // `event.servers.map(...)` replacement (isFormA forced to `false`, so
    // the merge branch never runs) made this assertion fail with an actual
    // status of 404 (`"MCP server 'chrome-devtools' with hash 'hash-1' not
    // found"`). Reverted after confirming the failure.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker: { type: string; mcpServers?: Array<{ name: string; scope: string; hash?: string; decision?: string }> };
    };
    expect(body.worker.type).toBe('embedded-agent');
    const chromeDevtools = body.worker.mcpServers?.find((entry) => entry.name === 'chrome-devtools');
    expect(chromeDevtools).toEqual({ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'allowed' });
  });

  it('REST permission round trip: allow -> a live set-mcp-servers command carrying (name, hash) pairs is observed on the fake subprocess stdin -> the response reflects the decision', async () => {
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' }],
    });
    await waitFor(() => {
      const w = ctx.sessionManager.getSession(sessionId)?.workers.find((x) => x.id === workerId);
      return w?.type === 'embedded-agent' && w.mcpServers !== undefined;
    });

    const before = fake.stdinWrites.length;
    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}/mcp-permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chrome-devtools', hash: 'hash-1', decision: 'allow' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker: { type: string; mcpServers?: Array<{ name: string; scope: string; hash?: string; decision?: string }> };
    };
    expect(body.worker.type).toBe('embedded-agent');
    expect(body.worker.mcpServers).toEqual([
      { name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'allowed' },
    ]);

    // The LIVE-apply command: (name, hash) pairs ONLY, never a server config.
    await waitFor(() => fake.stdinWrites.length > before);
    const commandRaw = JSON.parse(fake.stdinWrites[before]);
    const parsedCommand = v.safeParse(EmbeddedAgentCommandSchema, commandRaw);
    expect(parsedCommand.success).toBe(true);
    if (parsedCommand.success && parsedCommand.output.type === 'set-mcp-servers') {
      expect(parsedCommand.output.allowedProjectMcpServers).toEqual([{ name: 'chrome-devtools', hash: 'hash-1' }]);
      // Never a server config anywhere on this command.
      expect('servers' in commandRaw).toBe(false);
    } else {
      throw new Error('expected a set-mcp-servers command');
    }
  });

  it('REST permission round trip: a hash that differs from the discovered pair returns 404 with the hoisted resolvePermissionDecisions not-discovered text (the hoist changed nothing at the wire)', async () => {
    // Orchestrator disposition (preflight-check.js Integration test gap on
    // routes/workers.ts's hoist of resolvePermissionDecisions into
    // lib/mcp-server-permissions.ts): this is the wire-layer pin that the
    // hoist changed nothing -- workers.test.ts (route-unit, fake service)
    // cannot fully give this, because it never drives the real fake
    // subprocess + real activation + real route dispatch together.
    //
    // Polarity confirmed: temporarily swapping the route's `kind` mapping
    // (routes/workers.ts, `if (resolved.kind === 'undecidable')` branch) to
    // `throw new ConflictError(resolved.message)` unconditionally -- so a
    // `not-discovered` result also produced 409 instead of 404 -- made this
    // test's `expect(res.status).toBe(404)` fail with an actual status of
    // 409, while the message-text assertion still passed. Reverted after
    // confirming the failure.
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [{ name: 'chrome-devtools', scope: 'project', hash: 'hash-1', decision: 'pending' }],
    });
    await waitFor(() => {
      const w = ctx.sessionManager.getSession(sessionId)?.workers.find((x) => x.id === workerId);
      return w?.type === 'embedded-agent' && w.mcpServers !== undefined;
    });

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}/mcp-permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chrome-devtools', hash: 'a-different-hash', decision: 'allow' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    // resolvePermissionDecisions's exact not-discovered message text, as
    // wrapped by NotFoundError (`${resource} not found`) and serialized by
    // the error-handler middleware's `{ error: message }` shape.
    expect(body.error).toBe("MCP server 'chrome-devtools' with hash 'a-different-hash' not found");
  });

  it('rejects the STALE full-config set-mcp-servers payload shape (Q10 dropped-frame failure mode)', () => {
    const staleFrame = {
      v: 1,
      type: 'set-mcp-servers',
      servers: { 'chrome-devtools': { type: 'stdio', command: 'chrome-devtools-mcp' } },
    };
    const parsed = v.safeParse(EmbeddedAgentCommandSchema, staleFrame);
    expect(parsed.success).toBe(false);
  });

  it('epic #1636 Phase 5 PR-3b: mcp-servers-discovered (mcpJsonError) and mcp-servers-applied (applied:false, reason) survive the real persistence/replay round trip and populate the CLIENT STORE\'s mcpDiscovery/lastMcpApply snapshot fields', async () => {
    const { sessionId, workerId } = await createSdkWorktreeWorker();
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(() => fake.stdinWrites.length >= 1);

    // Form (a)-shaped discovery that failed to read .mcp.json -- `servers`
    // empty, `mcpJsonError` present. Real engine shape per
    // `emitMcpServersDiscovered`'s own doc comment.
    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-discovered',
      servers: [],
      mcpJsonError: 'ENOENT: .mcp.json not found',
    });
    // A live-apply refusal with a free-form reason (never a silent no-op --
    // see the event's own doc comment in types/embedded-agent.ts).
    fake.pushStdoutLine({
      v: 1,
      type: 'mcp-servers-applied',
      applied: false,
      reason: 'delivery-failed',
    });

    await waitFor(async () => {
      const hist = await ctx.sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
      return !!hist && hist.data.includes('mcp-servers-applied');
    });
    const history = await ctx.sessionManager.getWorkerOutputHistory(sessionId, workerId, 0);
    expect(history).not.toBeNull();

    // Feed the REAL persisted bytes -- not a hand-typed literal -- into the
    // REAL client store exactly the way a worker-WS `history` push would.
    _resetEmbeddedAgentWorkers();
    const restoreWs = installMockWebSocket();
    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    try {
      const instance = getOrCreateEmbeddedAgentWorker(sessionId, workerId);
      const ws = MockWebSocket.getLastInstance();
      ws!.simulateOpen();
      ws!.simulateMessage(
        JSON.stringify({
          type: 'history',
          data: history!.data,
          offset: history!.offset,
          startOffset: history!.startOffset,
          epoch: history!.epoch,
        }),
      );
      await waitFor(() => instance.getSnapshot().lastMcpApply !== null);

      const snapshot = instance.getSnapshot();
      expect(snapshot.mcpDiscovery).toEqual({ mcpJsonError: 'ENOENT: .mcp.json not found' });
      expect(snapshot.lastMcpApply?.applied).toBe(false);
      expect(snapshot.lastMcpApply?.reason).toBe('delivery-failed');
      // Polarity (Orchestrator disposition, 2026-09-21): reverting the
      // store's `mcp-servers-applied` case to the PR-2 no-op
      // (`return false` with no `this.patch(...)`) made this assertion fail
      // with `lastMcpApply` still `null`. Reverted after confirming the
      // failure.
    } finally {
      _resetEmbeddedAgentWorkers();
      restoreWs();
      if (originalLocation) {
        Object.defineProperty(window, 'location', originalLocation);
      }
    }
  });
});
