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
import { serverConfig } from '../../lib/server-config.js';
import type { WorktreeService } from '../worktree-service.js';

type ExecuteHookCommand = WorktreeService['executeHookCommand'];
type HookResult = Awaited<ReturnType<ExecuteHookCommand>>;

const TEST_CONFIG_DIR = '/test/config';
const RESUME_COMMAND = 'docker compose start';

let importCounter = 0;
let ptyFactory: ReturnType<typeof createMockPtyFactory>;
// Shared call log: the hook mock pushes 'hook', the PTY provider pushes 'activate'.
let callLog: string[];

// Auto-resume of a persisted session (no serverPid, so it is inherited and resumed) runs the repository's resume command (before worker
// activation) because initialize() goes through the same resume path as a manual resume.
// These tests pin that behaviour so a later decision to skip the hook on auto-resume flips them.
describe('SessionManager auto-resume runs the resume command', () => {
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

  it('runs the repository resume command once, with the time box, before worker activation', async () => {
    persistSessions([worktreeSession()]);
    const executeHookCommand = mock(async (..._args: unknown[]): Promise<HookResult> => {
      callLog.push('hook');
      return { success: true };
    });

    await createSessionManager(executeHookCommand as unknown as ExecuteHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
      resumeCommand: RESUME_COMMAND,
    });

    expect(executeHookCommand).toHaveBeenCalledTimes(1);
    const [command, locationPath, , , timeoutMs] = executeHookCommand.mock.calls[0];
    expect(command).toBe(RESUME_COMMAND);
    expect(locationPath).toBe('/path/to/worktree');
    expect(timeoutMs).toBe(serverConfig.SESSION_HOOK_COMMAND_TIMEOUT_MS);

    expect(callLog).toContain('hook');
    expect(callLog).toContain('activate');
    expect(callLog.indexOf('hook')).toBeLessThan(callLog.indexOf('activate'));
    expect(persistedServerPid('wt-session')).toBe(process.pid);
  });

  it('a resume command that hits the time box does not stall or abort initialization', async () => {
    // The 60 s bound is enforced inside WorktreeService.executeHookCommand, so this mock
    // does not wait on a timer: it stays pending until the test resolves it with the
    // failure the real runner reports on timeout. Fake timers are not used because
    // initialize() awaits DB and memfs I/O, which a mocked clock does not drive reliably.
    persistSessions([worktreeSession()]);
    let resolveHook!: (result: HookResult) => void;
    let receivedTimeoutMs: unknown;
    const executeHookCommand = mock((...args: unknown[]) => {
      callLog.push('hook');
      receivedTimeoutMs = args[4];
      return new Promise<HookResult>((resolve) => {
        resolveHook = resolve;
      });
    });

    let settled = false;
    const managerPromise = createSessionManager(executeHookCommand as unknown as ExecuteHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
      resumeCommand: RESUME_COMMAND,
    }).then((manager) => {
      settled = true;
      return manager;
    });

    for (let i = 0; i < 200 && executeHookCommand.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(executeHookCommand).toHaveBeenCalledTimes(1);
    expect(receivedTimeoutMs).toBe(serverConfig.SESSION_HOOK_COMMAND_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(callLog).not.toContain('activate');

    resolveHook({ success: false, error: `Command timed out after ${String(receivedTimeoutMs)} ms` });
    await managerPromise;

    expect(callLog).toContain('activate');
    expect(persistedServerPid('wt-session')).toBe(process.pid);
  });

  it('does not call the hook for a worktree session whose repository has no resume command', async () => {
    persistSessions([worktreeSession()]);
    const executeHookCommand = mock(async (..._args: unknown[]): Promise<HookResult> => ({ success: true }));

    await createSessionManager(executeHookCommand as unknown as ExecuteHookCommand, {
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
    const executeHookCommand = mock(async (..._args: unknown[]): Promise<HookResult> => ({ success: true }));

    await createSessionManager(executeHookCommand as unknown as ExecuteHookCommand, {
      name: 'test-repo',
      path: '/test/repo',
      resumeCommand: RESUME_COMMAND,
    });

    expect(executeHookCommand).not.toHaveBeenCalled();
    expect(persistedServerPid('quick-session')).toBe(process.pid);
  });
});
