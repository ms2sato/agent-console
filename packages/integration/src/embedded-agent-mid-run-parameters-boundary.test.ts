/**
 * Client-Server Boundary Test: mid-run model / reasoning-effort /
 * context-window change for an embedded-agent worker (agent-surface.md
 * Phase 3, CLAUDE.md Q10)
 *
 * Phase 3 added three fields to the public `EmbeddedAgentWorker` wire shape
 * (`model`, `reasoningEffort`, `hasParameterOverride`), composed server-side,
 * plus TWO write surfaces that produce them: the widened
 * `PATCH /api/sessions/:sessionId/workers/:workerId` and the
 * `set_agent_parameters` MCP tool. Per pre-pr-completeness.md Q10, a derived
 * shared-type field that crosses the wire needs a test that exercises the
 * REAL chain: a server unit test asserts an in-memory object and a client
 * unit test injects a mock worker, so neither would notice a field missing
 * from `EmbeddedAgentWorkerSchema`. Since the schemas are `v.strictObject`,
 * such an omission does not merely blank the field -- `parseMessage` in
 * `packages/client/src/lib/app-websocket.ts` discards the ENTIRE
 * `session-updated` frame and logs one line to the browser console.
 *
 * Both write surfaces are covered here, in one file, because they are two
 * doors into the same state and the wire boundary they both end at is the
 * thing under test:
 *
 *   1. real HTTP PATCH /api/sessions/:id/workers/:id { model, contextWindowTokens }
 *        -> real vValidator(UpdateEmbeddedAgentWorkerRequestSchema)
 *        -> real route handler -> real SessionManager.setEmbeddedAgentParameters
 *        -> real persisted worker ROW (read from the instance's own SQLite)
 *        -> real public session -> JSON wire -> AppServerMessageSchema.safeParse
 *
 *   2. real /mcp JSON-RPC tools/call set_agent_parameters { reasoningEffort }
 *        (with a REAL minted bearer token, since the tool refuses a caller
 *         with no verified identity in every auth mode)
 *        -> same handler chain -> same persisted row -> same parse
 *
 * Reach measured 2026-09-04: deleting `hasParameterOverride` from
 * `EmbeddedAgentWorkerSchema` in
 * `packages/shared/src/schemas/app-server-message.ts` fails ALL THREE tests
 * below at the `safeParse` step ("Invalid type: Expected Object but received
 * Object" -- the strictObject union member no longer matches), and restoring
 * it returns them to green.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';
import { Hono } from 'hono';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';

import { AppServerMessageSchema } from '@agent-console/shared';

/** Minimal MCP JSON-RPC handshake + tools/call, same shape as the server package's helper. */
async function initializeMcp(app: Hono): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await app.request('/mcp', {
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

async function callTool(
  app: Hono,
  mcpSessionId: string,
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 2 }),
  });
  return (await res.json()) as { result?: { content: Array<{ type: string; text: string }>; isError?: boolean } };
}

describe('Client-Server Boundary: mid-run embedded-agent parameter change (agent-surface.md Phase 3)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  /**
   * Seeds a user, a real embedded-agent definition, a real session and a
   * real embedded-agent worker on it, all through the production managers.
   */
  async function seed(osUid: number, username: string) {
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Boundary Test Embedded Agent',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        contextWindowTokens: 128_000,
      },
      owner.id,
    );
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    return { owner, def, sessionId: session.id, workerId: worker!.id };
  }

  /** The persisted worker row, read from the disposable instance's own SQLite. */
  async function readWorkerRow(workerId: string) {
    return ctx.db
      .selectFrom('workers')
      .where('id', '=', workerId)
      .select(['model', 'reasoning_effort', 'context_window_tokens'])
      .executeTakeFirstOrThrow();
  }

  /**
   * Builds the real `session-updated` payload the server broadcasts, sends it
   * through JSON, and parses it with the SAME schema the client's
   * `parseMessage` uses. Returns the parsed embedded-agent worker.
   */
  function parseThroughWire(sessionId: string, workerId: string) {
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error('session not found');

    const wirePayload = JSON.parse(JSON.stringify({ type: 'session-updated', session }));
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);
    if (!parsed.success) {
      throw new Error(
        `safeParse rejected the session-updated frame: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'session-updated') throw new Error('expected session-updated');

    const parsedWorker = parsed.output.session.workers.find((w) => w.id === workerId);
    if (!parsedWorker || parsedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker stripped by the schema parser');
    }
    return parsedWorker;
  }

  it('PATCH: the override reaches the persisted row AND survives the session-updated wire parse', async () => {
    const { sessionId, workerId } = await seed(64901, 'owner-phase3-patch');
    const app = await createTestApp(ctx);

    // Before: the worker has no override, and the wire still carries the
    // three fields (composed from the definition), so the "after" assertions
    // below cannot pass merely because the fields exist.
    const before = parseThroughWire(sessionId, workerId);
    expect(before.model).toBe('qwen3:32b');
    expect(before.reasoningEffort).toBeNull();
    expect(before.hasParameterOverride).toBe(false);

    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:14b', reasoningEffort: 'high', contextWindowTokens: 32_000 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker: { model?: string; reasoningEffort: string | null; hasParameterOverride: boolean };
    };
    expect(body.worker.model).toBe('qwen3:14b');
    expect(body.worker.reasoningEffort).toBe('high');
    expect(body.worker.hasParameterOverride).toBe(true);

    const row = await readWorkerRow(workerId);
    expect(row.model).toBe('qwen3:14b');
    expect(row.reasoning_effort).toBe('high');
    expect(row.context_window_tokens).toBe(32_000);

    const parsedWorker = parseThroughWire(sessionId, workerId);
    expect(parsedWorker.model).toBe('qwen3:14b');
    expect(parsedWorker.reasoningEffort).toBe('high');
    expect(parsedWorker.hasParameterOverride).toBe(true);
    // The effective window, composed server-side by resolveEffectiveContextWindow.
    expect(parsedWorker.contextWindowTokens).toBe(32_000);
  });

  it('PATCH: clearing with nulls reaches the row and the wire, back to definition defaults', async () => {
    const { sessionId, workerId } = await seed(64902, 'owner-phase3-clear');
    const app = await createTestApp(ctx);
    await app.request(`/api/sessions/${sessionId}/workers/${workerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:14b', reasoningEffort: 'high', contextWindowTokens: 32_000 }),
    });

    const res = await app.request(`/api/sessions/${sessionId}/workers/${workerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null, reasoningEffort: null }),
    });

    expect(res.status).toBe(200);
    const row = await readWorkerRow(workerId);
    expect(row.model).toBeNull();
    expect(row.reasoning_effort).toBeNull();
    // Cleared with the model, by construction (Ruling 4, server-side half).
    expect(row.context_window_tokens).toBeNull();

    const parsedWorker = parseThroughWire(sessionId, workerId);
    expect(parsedWorker.model).toBe('qwen3:32b');
    expect(parsedWorker.reasoningEffort).toBeNull();
    expect(parsedWorker.hasParameterOverride).toBe(false);
    // With no model override the definition's own window applies again.
    expect(parsedWorker.contextWindowTokens).toBe(128_000);
  });

  it('MCP: set_agent_parameters through the real /mcp endpoint reaches the same row and the same wire shape', async () => {
    const { owner, sessionId, workerId } = await seed(64903, 'owner-phase3-mcp');

    // The MCP app is mounted against the SAME AppContext -- crucially the
    // same `mcpTokenRegistry` the tool's caller-identity guard verifies
    // against, so a token minted here is a real, verifiable identity.
    const mcpApp = createMcpApp({
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
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
      mcpAuthMode: 'off',
      mcpTokenRegistry: ctx.mcpTokenRegistry,
    });
    const app = new Hono();
    app.route('', mcpApp);
    const mcpSessionId = await initializeMcp(app);

    // The same identity an embedded-agent worker is given at activation.
    const token = ctx.mcpTokenRegistry.mint({ sessionId, workerId, userId: owner.id });

    const response = await callTool(
      app,
      mcpSessionId,
      'set_agent_parameters',
      { sessionId, workerId, model: 'qwen3:14b', contextWindowTokens: 32_000 },
      token,
    );

    expect(response.result?.isError).toBeUndefined();
    const data = JSON.parse(response.result!.content[0].text) as {
      worker: { model?: string; hasParameterOverride: boolean };
    };
    expect(data.worker.model).toBe('qwen3:14b');
    expect(data.worker.hasParameterOverride).toBe(true);

    const row = await readWorkerRow(workerId);
    expect(row.model).toBe('qwen3:14b');
    expect(row.context_window_tokens).toBe(32_000);

    const parsedWorker = parseThroughWire(sessionId, workerId);
    expect(parsedWorker.model).toBe('qwen3:14b');
    expect(parsedWorker.hasParameterOverride).toBe(true);
    expect(parsedWorker.contextWindowTokens).toBe(32_000);
  });
});
