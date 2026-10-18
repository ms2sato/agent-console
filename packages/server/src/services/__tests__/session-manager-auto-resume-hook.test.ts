import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import type { PersistedSession } from '../../repositories/persisted-types.js';
import type { RepositoryInfo } from '../repository-lookup-types.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { defaultRepositoryLookup, makeRepositoryEnvLookup } from '../../__tests__/utils/repository-lookup-mock.js';
import {
  buildPersistedQuickSession,
  buildPersistedWorktreeSession,
  buildPersistedAgentWorker,
} from '../../__tests__/utils/build-test-data.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { AgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SingleUserMode } from '../user-mode.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { createTestSessionRepository } from '../../__tests__/utils/test-session-repository.js';
import type { ExecuteHookCommand } from '../session-manager.js';

type HookResult = Awaited<ReturnType<ExecuteHookCommand>>;

const TEST_CONFIG_DIR = '/test/config';
const RESUME_COMMAND = 'docker compose start';

let importCounter = 0;
let ptyFactory: ReturnType<typeof createMockPtyFactory>;
// Shared call log: the hook mock pushes 'hook', the PTY provider pushes 'activate'.
let callLog: string[];

// Auto-resume at server start brings workers back but does NOT run the repository's resume command:
// a server-only restart (every deploy) leaves the containers running and no pause command ran, so a
// non-idempotent resume command would start things twice. The command runs only on a user resume.
describe('SessionManager auto-resume does not run the resume command', () => {
  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    ptyFactory = createMockPtyFactory();
    callLog = [];
    fs.mkdirSync('/path/to/worktree', { recursive: true });
    fs.writeFileSync(`${TEST_CONFIG_DIR}/agents.json`, JSON.stringify([]));
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  function persistSessions(sessions: PersistedSession[]): void {
    fs.writeFileSync(`${TEST_CONFIG_DIR}/sessions.json`, JSON.stringify(sessions));
  }

  function worktreeSession(id = 'wt-session') {
    return buildPersistedWorktreeSession({
      id,
      locationPath: '/path/to/worktree',
      repositoryId: 'repo-1',
      dataScope: 'repository',
      dataScopeSlug: 'test-repo',
      workers: [
        buildPersistedAgentWorker({ id: 'worker-1', name: 'Claude', agentId: 'claude-code', pid: 11111 }),
      ],
    });
  }

  function createSessionManager(
    executeHookCommand: ExecuteHookCommand,
    repository: RepositoryInfo | undefined,
  ) {
    return (async () => {
      const module = await import(`../session-manager.js?v=${++importCounter}`) as typeof import('../session-manager.js');
      const agentManager = await AgentManager.create(new SqliteAgentRepository(getDatabase()));
      const trackingProvider = {
        spawn: (...args: Parameters<typeof ptyFactory.provider.spawn>) => {
          callLog.push('activate');
          return ptyFactory.provider.spawn(...args);
        },
      };
      return module.SessionManager.create({
        sessionRepository: await createTestSessionRepository(),
        userMode: new SingleUserMode(trackingProvider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
        agentManager,
        mcpTokenRegistry: new McpTokenRegistry(),
        repositoryLookup: defaultRepositoryLookup,
        repositoryEnvLookup: makeRepositoryEnvLookup({ mapping: () => repository }),
        pathExists: async () => true,
        executeHookCommand,
      });
    })();
  }

  function persistedServerPid(id: string): number | null | undefined {
    const saved = JSON.parse(fs.readFileSync(`${TEST_CONFIG_DIR}/sessions.json`, 'utf-8')) as PersistedSession[];
    return saved.find((s) => s.id === id)?.serverPid;
  }

  it('does not call the resume hook for a session with a resume command, but still resumes its workers', async () => {
    persistSessions([worktreeSession()]);
    const executeHookCommand = mock<ExecuteHookCommand>(async (): Promise<HookResult> => {
      callLog.push('hook');
      return { success: true };
    });

    await createSessionManager(executeHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
      resumeCommand: RESUME_COMMAND,
    });

    expect(executeHookCommand).not.toHaveBeenCalled();
    expect(callLog).toContain('activate');
    expect(persistedServerPid('wt-session')).toBe(process.pid);
  });

  it('does not call the hook for a worktree session whose repository has no resume command', async () => {
    persistSessions([worktreeSession()]);
    const executeHookCommand = mock<ExecuteHookCommand>(async (): Promise<HookResult> => ({ success: true }));

    await createSessionManager(executeHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
    });

    expect(executeHookCommand).not.toHaveBeenCalled();
    expect(persistedServerPid('wt-session')).toBe(process.pid);
  });

  it('does not call the hook for a quick session', async () => {
    persistSessions([
      buildPersistedQuickSession({
        id: 'quick-session',
        locationPath: '/path/to/worktree',
        workers: [
          buildPersistedAgentWorker({ id: 'worker-1', name: 'Claude', agentId: 'claude-code', pid: 11111 }),
        ],
        serverPid: 55555,
      }),
    ]);
    const executeHookCommand = mock<ExecuteHookCommand>(async (): Promise<HookResult> => ({ success: true }));

    await createSessionManager(executeHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
      resumeCommand: RESUME_COMMAND,
    });

    expect(executeHookCommand).not.toHaveBeenCalled();
    expect(persistedServerPid('quick-session')).toBe(process.pid);
  });
});
