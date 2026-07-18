/**
 * Cross-Package Boundary Test: agent surface parity (Issue #1160 PR-A)
 *
 * Verifies `list_agents`'s wire-level JSON shape end-to-end through the real
 * pipeline: real `AgentManager` (SQLite-backed) + real `EmbeddedAgentManager`
 * (SQLite-backed) + real `AgentDirectory` composite, mounted on `createMcpApp`
 * and driven via actual HTTP `/mcp` requests -- no stubs for the registries
 * themselves.
 *
 * Scope: `list_agents` only. `delegate_to_worktree`'s agentId/agentName
 * resolution (`AgentDirectory.resolve`) is already covered at the unit level
 * by mcp-server.test.ts's "EmbeddedAgent selection (Issue #1161)" describe
 * block (with mocked worktree creation); re-exercising the full
 * worktree-creation side effects here would duplicate that coverage for no
 * additional wire-boundary confidence, since `list_agents` has no
 * worktree-creation side effects and is a cheap, fast boundary test.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { AgentDirectory } from '@agent-console/server/src/services/agent-directory';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { ConditionalWakeupManager } from '@agent-console/server/src/services/conditional-wakeup-manager';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

// ---------- MCP helpers (mirrors mcp-server.test.ts / interactive-process-boundary.test.ts) ----------

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

describe('Agent surface boundary: list_agents wire-level shape (Issue #1160 PR-A)', () => {
  let app: Hono;
  let mcpSessionId: string;
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
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
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);
    const userRepository = new SqliteUserRepository(db);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
    });

    const mcpApp = createMcpApp({
      sessionManager,
      repositoryManager: await RepositoryManager.create({
        jobQueue: testJobQueue,
        repository: new SqliteRepositoryRepository(db),
      }),
      agentManager,
      agentDirectory,
      timerManager: new TimerManager(() => {}),
      conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
      interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
      worktreeService: new WorktreeService({ db }),
      annotationService: new AnnotationService(),
      interSessionMessageService: new InterSessionMessageService(),
      suggestSessionMetadata: async () => ({ branch: 'feat/test', title: 'Test' }),
      createWorktreeWithSession,
      deleteWorktree,
      userRepository,
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
    });

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

  it('returns a terminal entry (built-in Claude Code) with kind, isBuiltIn, capabilities', async () => {
    const response = await callTool(app, mcpSessionId, 'list_agents', {}, nextId++);
    expect(response.result?.isError).toBeUndefined();

    const data = parseToolResult(response) as {
      agents: Array<{
        kind: string;
        id: string;
        name: string;
        isBuiltIn?: boolean;
        capabilities?: {
          supportsContinue: boolean;
          supportsHeadlessMode: boolean;
          supportsActivityDetection: boolean;
        };
      }>;
    };

    const builtIn = data.agents.find((a) => a.id === 'claude-code-builtin');
    expect(builtIn).toBeDefined();
    expect(builtIn!.kind).toBe('terminal');
    expect(builtIn!.isBuiltIn).toBe(true);
    expect(builtIn!.capabilities).toBeDefined();
    expect(typeof builtIn!.capabilities!.supportsContinue).toBe('boolean');
  });

  it('after registering an embedded agent, list_agents gains one kind:"embedded" entry with no capabilities field', async () => {
    const before = parseToolResult(
      await callTool(app, mcpSessionId, 'list_agents', {}, nextId++),
    ) as { agents: Array<{ kind: string }> };
    const beforeEmbeddedCount = before.agents.filter((a) => a.kind === 'embedded').length;
    expect(beforeEmbeddedCount).toBe(0);

    const def = await embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Wire-boundary embedded agent',
        provider: { baseUrl: 'http://localhost:9/v1', model: 'stub-model' },
      },
      'creator-user-id',
    );

    const after = parseToolResult(
      await callTool(app, mcpSessionId, 'list_agents', {}, nextId++),
    ) as {
      agents: Array<{ kind: string; id: string; name: string; capabilities?: unknown }>;
    };
    const afterEmbedded = after.agents.filter((a) => a.kind === 'embedded');
    expect(afterEmbedded).toHaveLength(beforeEmbeddedCount + 1);

    const registered = afterEmbedded.find((a) => a.id === def.id);
    expect(registered).toBeDefined();
    expect(registered!.name).toBe('Wire-boundary embedded agent');
    expect(registered).not.toHaveProperty('capabilities');
  });
});
