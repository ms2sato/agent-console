/**
 * Client-Server Boundary Test: artifact/bookmark realtime refresh triggers
 * (Issue #1520).
 *
 * Exercises the real chain the client's cache-invalidation logic depends on:
 *   real MCP tool call (create_html_artifact / delete_html_artifact /
 *   create_bookmark / delete_bookmark) over the real `/mcp` JSON-RPC
 *   transport, mounted on a real `createMcpApp` wired to a real `AppContext`
 *   (real SQLite-backed repositories, real SessionManager)
 *     -> the tool handler's real `broadcastToApp(...)` call (captured by a
 *        spy, not a hand-built object)
 *     -> JSON serialize / parse (wire transmission simulation, same pattern
 *        as `created-by-username-boundary.test.ts`)
 *     -> `AppServerMessageSchema.safeParse` (the same parser
 *        `packages/client/src/lib/app-websocket.ts` uses).
 *
 * Per `.claude/rules/pre-pr-completeness.md` Q10: neither the server's MCP
 * tool tests (which assert the raw object passed to a mock `broadcastToApp`)
 * nor the shared package's schema unit tests (which parse hand-built
 * literals) exercise "the real MCP-produced shape survives the real wire
 * schema" end-to-end. This file closes that gap.
 *
 * Also carries the R1 structural pin (N1: "a broadcast is never a source of
 * list content") at this same real-shape boundary: an extra content field
 * grafted onto the REAL captured trigger payload must still be rejected by
 * `AppServerMessageSchema`, not just by a hand-built literal in the shared
 * package's own test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import {
  initializeMcp,
  callTool,
  parseToolResult,
} from '@agent-console/server/src/mcp/__tests__/mcp-protocol-test-helpers';

import { AppServerMessageSchema, type AppServerMessage } from '@agent-console/shared';

const TEST_LOCATION_PATH = '/test/path';

describe('Client-Server Boundary: artifact/bookmark realtime refresh triggers', () => {
  let ctx: AppContext;
  let app: Hono;
  let mcpSessionId: string;
  let capturedBroadcasts: AppServerMessage[];
  const originalAgentConsoleHome = process.env.AGENT_CONSOLE_HOME;
  /**
   * Real (non-memfs) directory for AGENT_CONSOLE_HOME: `SqliteArtifactRepository`
   * writes artifact bytes via `lib/artifact-storage.ts`'s `Bun.write`, which
   * bypasses the process-global `mock.module('fs/promises')` memfs
   * interception `setupTestEnvironment()` installs (same rationale as
   * `create-html-artifact.test.ts`'s file header).
   */
  let testConfigDir: string;

  beforeEach(async () => {
    await setupTestEnvironment();

    testConfigDir = path.join(os.tmpdir(), `agent-console-artifact-bookmark-trigger-boundary-${randomUUID()}`);
    process.env.AGENT_CONSOLE_HOME = testConfigDir;

    capturedBroadcasts = [];
    ctx = await createTestContext({
      broadcastToApp: (msg) => {
        capturedBroadcasts.push(msg);
      },
    });

    // Mirrors index.ts's production `createMcpApp(...)` wiring verbatim
    // (same field-for-field mapping from AppContext), so this test exercises
    // the actual production dependency composition, not a re-derived subset.
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
      broadcastToApp: ctx.broadcastToApp,
      fetchPullRequestUrl: ctx.fetchPullRequestUrl,
      findOpenPullRequest: ctx.findOpenPullRequest,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
    });
    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
    Bun.spawnSync(['rm', '-rf', testConfigDir]);
    if (originalAgentConsoleHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalAgentConsoleHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  async function createOwnedSession(osUid: number, username: string): Promise<{ sessionId: string }> {
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: TEST_LOCATION_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id };
  }

  /** Simulate wire transmission (matches created-by-username-boundary.test.ts's pattern). */
  function simulateWireTransmission(payload: unknown): unknown {
    return JSON.parse(JSON.stringify(payload));
  }

  let nextId = 100;

  it('artifact-created: real MCP call -> real broadcastToApp -> wire -> AppServerMessageSchema.safeParse', async () => {
    const { sessionId } = await createOwnedSession(1520001, 'trigger-owner-a');

    const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content: '<html></html>', sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { artifactId: string };

    expect(capturedBroadcasts).toHaveLength(1);
    const wirePayload = simulateWireTransmission(capturedBroadcasts[0]);
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
    if (parsed.output.type !== 'artifact-created') throw new Error(`Expected artifact-created, got: ${parsed.output.type}`);
    expect(parsed.output.sessionId).toBe(sessionId);
    expect(parsed.output.artifactId).toBe(data.artifactId);
  });

  it('artifact-deleted: real MCP call -> real broadcastToApp -> wire -> AppServerMessageSchema.safeParse', async () => {
    const { sessionId } = await createOwnedSession(1520002, 'trigger-owner-b');
    const createResponse = await callTool(app, mcpSessionId, 'create_html_artifact', { content: '<html></html>', sessionId }, nextId++);
    const { artifactId } = parseToolResult(createResponse) as { artifactId: string };
    capturedBroadcasts.length = 0; // Only interested in the delete trigger below.

    const response = await callTool(app, mcpSessionId, 'delete_html_artifact', { artifactId, sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();

    expect(capturedBroadcasts).toHaveLength(1);
    const wirePayload = simulateWireTransmission(capturedBroadcasts[0]);
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
    if (parsed.output.type !== 'artifact-deleted') throw new Error(`Expected artifact-deleted, got: ${parsed.output.type}`);
    expect(parsed.output.sessionId).toBe(sessionId);
    expect(parsed.output.artifactId).toBe(artifactId);
  });

  it('bookmark-created: real MCP call -> real broadcastToApp -> wire -> AppServerMessageSchema.safeParse', async () => {
    const { sessionId } = await createOwnedSession(1520003, 'trigger-owner-c');

    const response = await callTool(app, mcpSessionId, 'create_bookmark', { url: 'https://example.com', sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();
    const data = parseToolResult(response) as { id: string };

    expect(capturedBroadcasts).toHaveLength(1);
    const wirePayload = simulateWireTransmission(capturedBroadcasts[0]);
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
    if (parsed.output.type !== 'bookmark-created') throw new Error(`Expected bookmark-created, got: ${parsed.output.type}`);
    expect(parsed.output.sessionId).toBe(sessionId);
    expect(parsed.output.bookmarkId).toBe(data.id);
  });

  it('bookmark-deleted: real MCP call -> real broadcastToApp -> wire -> AppServerMessageSchema.safeParse', async () => {
    const { sessionId } = await createOwnedSession(1520004, 'trigger-owner-d');
    const createResponse = await callTool(app, mcpSessionId, 'create_bookmark', { url: 'https://example.com', sessionId }, nextId++);
    const { id: bookmarkId } = parseToolResult(createResponse) as { id: string };
    capturedBroadcasts.length = 0; // Only interested in the delete trigger below.

    const response = await callTool(app, mcpSessionId, 'delete_bookmark', { bookmarkId, sessionId }, nextId++);
    expect(response.result?.isError).toBeUndefined();

    expect(capturedBroadcasts).toHaveLength(1);
    const wirePayload = simulateWireTransmission(capturedBroadcasts[0]);
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues.map((i) => i.message)));
    if (parsed.output.type !== 'bookmark-deleted') throw new Error(`Expected bookmark-deleted, got: ${parsed.output.type}`);
    expect(parsed.output.sessionId).toBe(sessionId);
    expect(parsed.output.bookmarkId).toBe(bookmarkId);
  });

  it(
    'R1 structural pin: a REAL captured artifact-created trigger, with a content field grafted on, ' +
      'is rejected by AppServerMessageSchema (N1: a broadcast is never a source of list content)',
    async () => {
      const { sessionId } = await createOwnedSession(1520005, 'trigger-owner-e');
      const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content: '<html></html>', sessionId }, nextId++);
      expect(response.result?.isError).toBeUndefined();

      expect(capturedBroadcasts).toHaveLength(1);
      const realTriggerShape = capturedBroadcasts[0];
      const leakedPayload = simulateWireTransmission({ ...realTriggerShape, title: 'leaked content' });

      const parsed = v.safeParse(AppServerMessageSchema, leakedPayload);
      expect(parsed.success).toBe(false);
    },
  );
});
