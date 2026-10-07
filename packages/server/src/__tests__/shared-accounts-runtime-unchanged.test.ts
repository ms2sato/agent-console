/**
 * Release-1 runtime-unchanged pin (shared-accounts design).
 *
 * Release 1 adds DB-backed storage for the shared-account SET
 * (`shared_accounts`) and a per-repository BINDING
 * (`repositories.shared_account_user_id`). Session creation and the
 * access-control path must keep reading `AGENT_CONSOLE_SHARED_USERNAME` via
 * `SharedAccountRegistry` exactly as before -- nothing introduced in
 * Release 1 may be consulted by the session-creation or access-check path.
 *
 * This test drives the REAL `POST /api/repositories/:id/worktrees` route
 * (the shipping shared-worktree-creation path, same mocking shape as
 * `routes/__tests__/worktrees.test.ts`'s "Issue #1286 shared worktree
 * sessions" describe block) against a repository that IS bound (in the DB)
 * to a DIFFERENT shared account than the one configured via
 * `AGENT_CONSOLE_SHARED_USERNAME`, and asserts the resulting session's
 * `createdBy` is the ENV-VAR account's `userId`, never the DB-bound
 * account's id. The route never reads `Repository.sharedAccountUsername`
 * anywhere in its own code, so a repo fixture carrying that field is enough
 * to prove it has no effect -- no real `SqliteSharedAccountRepository` row
 * is needed to make the point.
 *
 * This test is the Release 2 polarity seed: it must FLIP (start asserting
 * the BOUND account's id) when Release 2 wires the creation path to consult
 * the binding.
 */
import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { onApiError } from '../lib/error-handler.js';
import { api } from '../routes/api.js';
import type { AppBindings } from '../app-context.js';
import type { WorktreeService } from '../services/worktree-service.js';
import type { RepositoryManager } from '../services/repository-manager.js';
import type { SessionManager } from '../services/session-manager.js';
import type { AgentManager } from '../services/agent-manager.js';
import type { AgentDefinition, Repository, Session } from '@agent-console/shared';
import { asAppContext } from './test-utils.js';
import { resetGitMocks, mockGit } from './utils/mock-git-helper.js';
import { setupMemfs, cleanupMemfs } from './utils/mock-fs-helper.js';
import { SharedAccountRegistry } from '../services/shared-account-registry.js';

function asWorktreeService(stub: Partial<WorktreeService>): WorktreeService {
  return stub as WorktreeService;
}
function asRepositoryManager(stub: Partial<RepositoryManager>): RepositoryManager {
  return stub as RepositoryManager;
}
function asSessionManager(stub: Partial<SessionManager>): SessionManager {
  return stub as SessionManager;
}
function asAgentManager(stub: Partial<AgentManager>): AgentManager {
  return stub as AgentManager;
}

function buildAgentDefinitionFixture(overrides: Pick<AgentDefinition, 'id' | 'name'>): AgentDefinition {
  return {
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    commandTemplate: '{{prompt}}',
    capabilities: {
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    },
    ...overrides,
  };
}

function buildSessionFixture(overrides: Pick<Session, 'id'>): Session {
  return {
    type: 'quick',
    locationPath: '/test/quick-session',
    status: 'active',
    activationState: 'running',
    createdAt: '2024-01-01T00:00:00.000Z',
    workers: [],
    isShared: true,
    recoveryState: 'healthy',
    ...overrides,
  };
}

const TEST_CONFIG_DIR = '/test/config-runtime-unchanged';
const REPO_PATH = `${TEST_CONFIG_DIR}/repositories/owner/repo`;
const WORKTREE_PATH = `${REPO_PATH}/worktrees/wt-1`;

// Carries a DB-stored shared-account binding (Release 1 storage) to a
// DIFFERENT account than the one AGENT_CONSOLE_SHARED_USERNAME configures.
// The route must never read this field.
const TEST_REPO: Repository = {
  id: 'repo-1',
  name: 'test-repo',
  path: REPO_PATH,
  createdAt: new Date().toISOString(),
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
  sharedAccountUsername: 'db-bound-account',
};

describe('Shared-accounts Release 1: runtime unchanged', () => {
  it('session creation uses the env-var shared account, never the DB-bound one', async () => {
    resetGitMocks();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${REPO_PATH}/.keep`]: '',
      [`${WORKTREE_PATH}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('feature-branch'));

    try {
      // The env-var-configured shared account (what AGENT_CONSOLE_SHARED_USERNAME
      // resolves to at startup). A real SharedAccountRegistry, with only the
      // OS lookup + DB upsert faked -- isEnabled/getDefaultUserId run for real.
      const fakeUserRepository = {
        upsertByOsUid: mock((_uid: number, username: string, homeDir: string) =>
          Promise.resolve({ id: 'env-var-shared-user-id', username, homeDir }),
        ),
        findById: mock(() => Promise.resolve(null)),
      };
      const sharedAccountRegistry = await SharedAccountRegistry.create({
        username: 'env-var-shared-user',
        userRepository: fakeUserRepository,
        lookupOsUser: () => Promise.resolve({ uid: 7000, homeDir: '/home/env-var-shared-user' }),
      });
      const envVarSharedUserId = sharedAccountRegistry.getDefaultUserId();
      expect(envVarSharedUserId).toBe('env-var-shared-user-id');

      const mockRepositoryManager = asRepositoryManager({
        getRepository: mock((id: string) => (id === TEST_REPO.id ? TEST_REPO : undefined)),
      });
      const mockWorktreeService = asWorktreeService({
        listWorktrees: mock(() => Promise.resolve([])),
        verifyRepoAccessible: mock(() => Promise.resolve()),
        ensureRepoHasCommits: mock(() => Promise.resolve()),
        isWorktreeOf: mock(() => Promise.resolve(true)),
        getDefaultBranch: mock(() => Promise.resolve('main')),
        executeHookCommand: mock(() => Promise.resolve({ success: true })),
        removeWorktree: mock(() => Promise.resolve({ success: true })),
        removeOrphanedWorktree: mock(() => Promise.resolve()),
        getWorktreeIndexNumber: mock(() => Promise.resolve(0)),
        createWorktree: mock(() => Promise.resolve({ worktreePath: WORKTREE_PATH, index: 0 })),
      });
      const mockAgentManager = asAgentManager({
        getAgent: mock(() => buildAgentDefinitionFixture({ id: 'claude-code-builtin', name: 'Claude Code' })),
      });

      let resolveSessionCall!: (args: Parameters<SessionManager['createSession']>) => void;
      const sessionCaptured = new Promise<Parameters<SessionManager['createSession']>>((resolve) => {
        resolveSessionCall = resolve;
      });
      const sessionCreateMock = mock<SessionManager['createSession']>((...args) => {
        resolveSessionCall(args);
        return Promise.resolve(buildSessionFixture({ id: 'session-runtime-unchanged' }));
      });

      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', asAppContext({
          repositoryManager: mockRepositoryManager,
          worktreeService: mockWorktreeService,
          agentManager: mockAgentManager,
          sessionManager: asSessionManager({ createSession: sessionCreateMock }),
          broadcastToApp: () => {},
          suggestSessionMetadata: mock(async () => ({ branch: '', title: '', error: 'unused' })),
          sharedAccountRegistry,
        }));
        await next();
      });
      app.onError(onApiError);
      app.route('/api', api);

      const res = await app.request(`/api/repositories/${TEST_REPO.id}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-runtime-unchanged',
          mode: 'custom',
          branch: 'feature/runtime-unchanged',
          baseBranch: 'main',
          useRemote: false,
          autoStartSession: true,
          agentId: 'claude-code-builtin',
          shared: true,
        }),
      });
      expect(res.status).toBe(202);

      const [, context] = await sessionCaptured;
      expect(context?.createdBy).toBe(envVarSharedUserId as string);
      // The crucial negative assertion: the DB-bound account's identity
      // (carried on TEST_REPO.sharedAccountUsername) must never surface as
      // the session's createdBy -- it isn't even a `users.id`, so any
      // equality here would itself be a bug, but asserting inequality keeps
      // the intent explicit for a future reader.
      expect(context?.createdBy).not.toBe('db-bound-account');
    } finally {
      cleanupMemfs();
    }
  });
});
