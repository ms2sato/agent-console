/**
 * Cross-Package Boundary Test: update_repository MCP tool
 *
 * Verifies that the update_repository MCP tool's payload round-trips
 * through valibot's UpdateRepositoryRequestSchema at the persistence
 * layer and lands in SQLite exactly as sent — catches schema drift
 * between the MCP tool's zod input and the SQLite update layer's
 * RepositoryUpdates shape that unit tests on either side can miss.
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
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';

const TEST_CONFIG_DIR = '/test/config';
const TEST_REPO_PATH = '/test/repo';
const ptyFactory = createMockPtyFactory();

// ---------- MCP helpers ----------

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

describe('update_repository MCP boundary: SQLite round-trip', () => {
  let app: Hono;
  let mcpSessionId: string;
  let testJobQueue: JobQueue;
  let nextId: number;

  beforeEach(async () => {
    await closeDatabase();

    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
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

    const sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      annotationService: new AnnotationService(),
    });

    // Persist a repository directly via the SQLite repository so the MCP
    // tool has something to update. The RepositoryManager loads existing
    // rows during `create()`, and the memfs `.git/HEAD` fixture above
    // keeps the path-existence check happy.
    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: 'repo-1',
      name: 'my-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      clonedSourceRepoPath: null,
      description: 'initial description',
    });

    const repositoryManager = await RepositoryManager.create({
      jobQueue: testJobQueue,
      repository: sqliteRepoRepo,
    });

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager,
      agentManager,
      timerManager: new TimerManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: mock(async () => ({ branch: 'feat/test', title: 'Test' })) as any,
      createWorktreeWithSession,
      deleteWorktree,
      broadcastToApp: () => {},
      findOpenPullRequest: mock(async () => null) as any,
      fetchPullRequestUrl: mock(async () => null) as any,
    } as any);

    app = new Hono();
    app.route('', mcpApp);
    mcpSessionId = await initializeMcp(app);
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('update_repository writes to SQLite and is readable via a fresh SqliteRepositoryRepository', async () => {
    const response = await callTool(app, mcpSessionId, 'update_repository', {
      repositoryId: 'repo-1',
      setupCommand: 'bun install',
      cleanupCommand: 'bun run cleanup',
      description: 'updated via MCP',
      envVars: 'FOO=bar',
    }, nextId++);

    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as {
      repository?: Record<string, unknown>;
    };
    expect(data.repository).toBeDefined();
    expect(data.repository!.id).toBe('repo-1');
    expect(data.repository!.setupCommand).toBe('bun install');
    expect(data.repository!.cleanupCommand).toBe('bun run cleanup');
    expect(data.repository!.description).toBe('updated via MCP');
    expect(data.repository!.envVars).toBe('FOO=bar');

    // Instantiate a NEW SqliteRepositoryRepository against the same DB and
    // verify the update actually hit SQLite, not just the in-memory
    // RepositoryManager cache.
    const fresh = new SqliteRepositoryRepository(getDatabase());
    const stored = await fresh.findById('repo-1');
    expect(stored).not.toBeNull();
    expect(stored!.setupCommand).toBe('bun install');
    expect(stored!.cleanupCommand).toBe('bun run cleanup');
    expect(stored!.description).toBe('updated via MCP');
    expect(stored!.envVars).toBe('FOO=bar');
  });

  it('update_repository returns a structured MCP tool error for an unknown repositoryId', async () => {
    const response = await callTool(app, mcpSessionId, 'update_repository', {
      repositoryId: 'nonexistent-id',
      setupCommand: 'bun install',
    }, nextId++);

    expect(response.result?.isError).toBe(true);

    const data = parseToolResult(response) as { error?: string };
    expect(data.error).toContain('nonexistent-id');
  });
});
