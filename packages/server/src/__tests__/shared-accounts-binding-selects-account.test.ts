/**
 * Shared-accounts Release 2: worktree creation uses the repository's bound
 * account.
 *
 * Release 1 added DB-backed storage for the shared-account SET
 * (`shared_accounts`) and a per-repository BINDING
 * (`repositories.shared_account_user_id`), but runtime still read only
 * `AGENT_CONSOLE_SHARED_USERNAME` (this file's previous incarnation, renamed
 * from `shared-accounts-runtime-unchanged.test.ts`, pinned exactly that: the
 * route never consulted the binding).
 *
 * Release 2 (docs/design/shared-orchestrator-session.md §"Shared-Account Set
 * and Per-Repository Binding (DB-backed)") wires `POST
 * /api/repositories/:id/worktrees`'s `shared: true` branch to consult
 * `RepositoryManager.getSharedAccountUserId(repoId)` and resolve the result
 * through the (DB-backed) `SharedAccountRegistry`. This test is the Release 1
 * polarity seed's flip: it now asserts the resulting session's `createdBy`
 * IS the repository's bound account's `userId`.
 *
 * It also adds the selectivity control the Release 2 ruling called for: a
 * second repository, bound to a DIFFERENT shared account in the same
 * registry, and asserts each repository's shared-worktree session picks up
 * its OWN binding, not the other's -- so a pass cannot be explained by "any
 * registered account satisfies the check", only by the binding actually
 * being read per-repository.
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

const TEST_CONFIG_DIR = '/test/config-binding-selects-account';
const REPO_A_PATH = `${TEST_CONFIG_DIR}/repositories/owner/repo-a`;
const REPO_B_PATH = `${TEST_CONFIG_DIR}/repositories/owner/repo-b`;
const WORKTREE_A_PATH = `${REPO_A_PATH}/worktrees/wt-1`;
const WORKTREE_B_PATH = `${REPO_B_PATH}/worktrees/wt-1`;

const TEST_REPO_A: Repository = {
  id: 'repo-a',
  name: 'test-repo-a',
  path: REPO_A_PATH,
  createdAt: new Date().toISOString(),
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
  sharedAccountUsername: 'account-a',
};

const TEST_REPO_B: Repository = {
  id: 'repo-b',
  name: 'test-repo-b',
  path: REPO_B_PATH,
  createdAt: new Date().toISOString(),
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
  sharedAccountUsername: 'account-b',
};

const ACCOUNT_A_USER_ID = 'account-a-user-id';
const ACCOUNT_B_USER_ID = 'account-b-user-id';

describe('Shared-accounts Release 2: worktree creation uses the repository\'s bound account', () => {
  it('each repository\'s shared worktree session picks up its OWN bound account, not the other\'s', async () => {
    resetGitMocks();
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${REPO_A_PATH}/.keep`]: '',
      [`${REPO_B_PATH}/.keep`]: '',
      [`${WORKTREE_A_PATH}/.keep`]: '',
      [`${WORKTREE_B_PATH}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('feature-branch'));

    try {
      // A real SharedAccountRegistry (Release 2: built via createFromDb) with
      // TWO registered accounts. Only the DB-backed list() + OS lookup +
      // users upsert are faked; isEnabled/getEntry/isSharedUserId run for
      // real.
      const fakeUserRepository = {
        upsertByOsUid: mock((_uid: number, username: string, homeDir: string) => {
          const id = username === 'account-a' ? ACCOUNT_A_USER_ID : ACCOUNT_B_USER_ID;
          return Promise.resolve({ id, username, homeDir });
        }),
        findById: mock(() => Promise.resolve(null)),
        getPreferences: mock(() => Promise.resolve(null)),
        setPreferences: mock(() => Promise.resolve(true)),
      };
      const sharedAccountRegistry = await SharedAccountRegistry.createFromDb({
        sharedAccountRepository: {
          list: async () => [
            { userId: ACCOUNT_A_USER_ID, username: 'account-a', createdAt: '2024-01-01T00:00:00.000Z', createdBy: null },
            { userId: ACCOUNT_B_USER_ID, username: 'account-b', createdAt: '2024-01-01T00:00:00.000Z', createdBy: null },
          ],
          register: async () => {},
          unregister: async () => true,
          countBoundRepositories: async () => 0,
          countSessions: async () => 0,
        },
        userRepository: fakeUserRepository,
        lookupOsUser: (username) =>
          Promise.resolve({ uid: username === 'account-a' ? 7001 : 7002, homeDir: `/home/${username}` }),
      });
      expect(sharedAccountRegistry.getEntry(ACCOUNT_A_USER_ID)).toEqual({ username: 'account-a', resolvable: true });
      expect(sharedAccountRegistry.getEntry(ACCOUNT_B_USER_ID)).toEqual({ username: 'account-b', resolvable: true });

      // Repo A is bound to account A, repo B is bound to account B.
      const mockRepositoryManager = asRepositoryManager({
        getRepository: mock((id: string) => {
          if (id === TEST_REPO_A.id) return TEST_REPO_A;
          if (id === TEST_REPO_B.id) return TEST_REPO_B;
          return undefined;
        }),
        getSharedAccountUserId: mock((id: string) => {
          if (id === TEST_REPO_A.id) return Promise.resolve(ACCOUNT_A_USER_ID);
          if (id === TEST_REPO_B.id) return Promise.resolve(ACCOUNT_B_USER_ID);
          return Promise.resolve(null);
        }),
      });

      function buildWorktreeServiceFor(worktreePath: string) {
        return asWorktreeService({
          listWorktrees: mock(() => Promise.resolve([])),
          verifyRepoAccessible: mock(() => Promise.resolve()),
          ensureRepoHasCommits: mock(() => Promise.resolve()),
          isWorktreeOf: mock(() => Promise.resolve(true)),
          getDefaultBranch: mock(() => Promise.resolve('main')),
          executeHookCommand: mock(() => Promise.resolve({ success: true })),
          removeWorktree: mock(() => Promise.resolve({ success: true })),
          removeOrphanedWorktree: mock(() => Promise.resolve()),
          getWorktreeIndexNumber: mock(() => Promise.resolve(0)),
          createWorktree: mock(() => Promise.resolve({ worktreePath, index: 0 })),
        });
      }

      const mockAgentManager = asAgentManager({
        getAgent: mock(() => buildAgentDefinitionFixture({ id: 'claude-code-builtin', name: 'Claude Code' })),
      });

      async function createSharedWorktreeSession(repo: Repository, worktreePath: string, taskId: string): Promise<{ createdBy?: string; initiatedBy?: string }> {
        let resolveSessionCall!: (args: Parameters<SessionManager['createSession']>) => void;
        const sessionCaptured = new Promise<Parameters<SessionManager['createSession']>>((resolve) => {
          resolveSessionCall = resolve;
        });
        const sessionCreateMock = mock<SessionManager['createSession']>((...args) => {
          resolveSessionCall(args);
          return Promise.resolve(buildSessionFixture({ id: `session-${repo.id}` }));
        });

        const app = new Hono<AppBindings>();
        app.use('*', async (c, next) => {
          c.set('appContext', asAppContext({
            repositoryManager: mockRepositoryManager,
            worktreeService: buildWorktreeServiceFor(worktreePath),
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

        const res = await app.request(`/api/repositories/${repo.id}/worktrees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            mode: 'custom',
            branch: `feature/${taskId}`,
            baseBranch: 'main',
            useRemote: false,
            autoStartSession: true,
            agentId: 'claude-code-builtin',
            shared: true,
          }),
        });
        expect(res.status).toBe(202);

        const [, context] = await sessionCaptured;
        return context as { createdBy?: string; initiatedBy?: string };
      }

      const contextA = await createSharedWorktreeSession(TEST_REPO_A, WORKTREE_A_PATH, 'task-binding-a');
      const contextB = await createSharedWorktreeSession(TEST_REPO_B, WORKTREE_B_PATH, 'task-binding-b');

      // Positive: each session's createdBy IS its OWN repository's bound account.
      expect(contextA.createdBy).toBe(ACCOUNT_A_USER_ID);
      expect(contextB.createdBy).toBe(ACCOUNT_B_USER_ID);

      // Selectivity control: neither session picks up the OTHER repository's
      // bound account -- a pass above cannot be explained by "any registered
      // account satisfies the check".
      expect(contextA.createdBy).not.toBe(ACCOUNT_B_USER_ID);
      expect(contextB.createdBy).not.toBe(ACCOUNT_A_USER_ID);
    } finally {
      cleanupMemfs();
    }
  });
});
