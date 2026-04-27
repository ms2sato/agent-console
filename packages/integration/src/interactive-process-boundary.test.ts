/**
 * Cross-Package Boundary Test: Interactive Process MCP Tools
 *
 * Verifies that server MCP tool HTTP responses conform to the shared
 * InteractiveProcessInfo type contract. Catches field omissions, type
 * mismatches, or serialization issues (e.g., Date vs string) that
 * unit tests on either side cannot catch alone.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { mockProcess, resetProcessMock } from '@agent-console/server/src/__tests__/utils/mock-process-helper';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
// The shared type — this is the contract we're verifying
import type { InteractiveProcessInfo } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

// ---------- MCP helpers (from mcp-server.test.ts) ----------

async function initializeMcp(app: Hono): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(
  app: Hono,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}

// ---------- Tests ----------

describe('Interactive Process MCP boundary: shared type contract', () => {
  let app: Hono;
  let mcpSessionId: string;
  let sessionManager: SessionManager;
  let interactiveProcessManager: InteractiveProcessManager;
  let testJobQueue: JobQueue;
  let nextId: number;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');

    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      annotationService: new AnnotationService(),
    });

    interactiveProcessManager = new InteractiveProcessManager(() => {}, () => {});

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager: await RepositoryManager.create({ jobQueue: testJobQueue }),
      agentManager,
      timerManager: new TimerManager(() => {}),
      interactiveProcessManager,
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: mock(async () => ({ branch: 'feat/test', title: 'Test' })) as any,
      createWorktreeWithSession,
      deleteWorktree,
      broadcastToApp: () => {},
      findOpenPullRequest: mock(async () => null) as any,
      fetchPullRequestUrl: mock(async () => null) as any,
    });

    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
    nextId = 10;
  });

  afterEach(async () => {
    interactiveProcessManager.disposeAll();
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('run_process response conforms to InteractiveProcessInfo contract', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });
    const sessionId = session.id;
    const workerId = session.workers[0].id;

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId,
      workerId,
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as Record<string, unknown>;
    // Verify every required field of InteractiveProcessInfo exists with correct type
    expect(typeof data.processId).toBe('string');
    expect((data.processId as string).length).toBeGreaterThan(0);
    expect(typeof data.sessionId).toBe('string');
    expect(data.sessionId).toBe(sessionId);
    expect(typeof data.workerId).toBe('string');
    expect(data.workerId).toBe(workerId);
    expect(typeof data.command).toBe('string');
    expect(data.command).toBe('sleep 30');
    // outputMode defaults to 'pty' when omitted (Issue #664)
    expect(data.outputMode).toBe('pty');
  });

  it('run_process accepts outputMode "message" and surfaces it in the response', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
      outputMode: 'message',
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as Record<string, unknown>;
    expect(data.outputMode).toBe('message');
  });

  it('run_process rejects an invalid outputMode value', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const response = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
      outputMode: 'invalid-mode',
    }, nextId++);

    // zod enum rejection surfaces as an MCP-level error, not as isError on a successful tool call
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  it('list_processes returns items matching InteractiveProcessInfo shape', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
    }, nextId++);

    const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
    expect(listResponse.result?.isError).toBeUndefined();

    const list = parseToolResult(listResponse) as { processes: Record<string, unknown>[] };
    expect(list.processes).toHaveLength(1);

    // Verify each item has ALL InteractiveProcessInfo fields with correct types
    const info = list.processes[0];
    expect(typeof info.id).toBe('string');
    expect(typeof info.sessionId).toBe('string');
    expect(typeof info.workerId).toBe('string');
    expect(typeof info.command).toBe('string');
    expect(info.status).toBe('running');
    expect(typeof info.startedAt).toBe('string');
    // startedAt must be ISO date string (catches Date serialization issues)
    expect(new Date(info.startedAt as string).toISOString()).toBe(info.startedAt);
  });

  it('list_processes after kill shows process removed', async () => {
    const session = await sessionManager.createSession({
      type: 'quick',
      locationPath: '/test/path',
      agentId: 'claude-code',
    });

    const runResponse = await callTool(app, mcpSessionId, 'run_process', {
      command: 'sleep 30',
      sessionId: session.id,
      workerId: session.workers[0].id,
    }, nextId++);
    const { processId } = parseToolResult(runResponse) as { processId: string };

    const killResponse = await callTool(app, mcpSessionId, 'kill_process', { processId }, nextId++);
    const killData = parseToolResult(killResponse) as { killed: boolean };
    expect(killData.killed).toBe(true);

    // Killed processes are removed from the map
    const listResponse = await callTool(app, mcpSessionId, 'list_processes', {}, nextId++);
    const list = parseToolResult(listResponse) as { processes: unknown[] };
    expect(list.processes).toHaveLength(0);
  });
});
