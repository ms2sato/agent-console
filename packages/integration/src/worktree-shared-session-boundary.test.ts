/**
 * Cross-Package Boundary Test: worktree-created shared sessions (Issue #1286)
 *
 * `worktrees.ts`'s POST /:id/worktrees route resolves `body.shared` into
 * `context: { createdBy, initiatedBy }` and forwards it to
 * `createWorktreeWithSession` (unit-tested in `worktrees.test.ts` -- those
 * tests only assert what the mocked `sessionManager.createSession` receives
 * as arguments). No test exercises the REAL cross-package chain that derives
 * `Session.isShared` from those arguments:
 *
 *   createWorktreeWithSession(context: { createdBy, initiatedBy })
 *     -> SessionManager.createSession
 *     -> SessionConverterService.toPublicSession
 *     -> deriveIsShared(createdBy) via the real SharedAccountRegistry's
 *        isSharedUserId(createdBy) predicate (sharedAccountLookup DI seam)
 *
 * This test wires a real `SharedAccountRegistry` (backed by a real
 * `SqliteUserRepository`, mirroring `sessions.test.ts`'s shared-session
 * describe block) into `SessionManager` and drives the worktree-creation
 * service directly (mirrors the sibling
 * `worktree-embedded-agent-boundary.test.ts`'s service-layer harness),
 * confirming the resulting `Session` really has `isShared === true` for a
 * shared context and `isShared === false` for a personal one.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { AgentManager, CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import type { RunAsUserOpts, RunAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { SharedAccountRegistry } from '@agent-console/server/src/services/shared-account-registry';

const TEST_CONFIG_DIR = '/test/config';
const TEST_REPO_PATH = '/test/repo';
const TEST_REPO_ID = 'repo-1';
const ptyFactory = createMockPtyFactory();

describe('createWorktreeWithSession: shared-session Session.isShared derivation boundary', () => {
  let sessionManager: SessionManager;
  let worktreeService: WorktreeService;
  let testJobQueue: JobQueue;
  let sharedAccountRegistry: SharedAccountRegistry;
  let sharedUserId: string;
  const humanUserId = 'test-user-id';

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

    // Real SharedAccountRegistry backed by a real SqliteUserRepository
    // (mirrors sessions.test.ts's "shared sessions" describe block). Only
    // the OS-account lookup is faked, so the registry's own upsert +
    // isSharedUserId logic run for real.
    sharedAccountRegistry = await SharedAccountRegistry.create({
      username: 'shared-user',
      userRepository: new SqliteUserRepository(db),
      lookupOsUser: () => Promise.resolve({ uid: 6000, homeDir: '/home/shared-user' }),
    });
    sharedUserId = sharedAccountRegistry.getDefaultUserId()!;
    expect(sharedUserId).toBeTruthy();

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: humanUserId, username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      // The seam under test: Session.isShared is derived through this
      // lookup (see SessionConverterService.deriveIsShared).
      sharedAccountLookup: sharedAccountRegistry,
      repositoryLookup: {
        getRepositorySlug: (id) => (id === TEST_REPO_ID ? 'test-repo' : undefined),
      },
      repositoryEnvLookup: {
        getRepositoryInfo: () => undefined,
        getWorktreeIndexNumber: async () => 0,
      },
    });

    // Real WorktreeService with a stubbed `runAsUser` (same stub as
    // worktree-embedded-agent-boundary.test.ts): captures the worktree path
    // from the shell-escaped `git worktree add` command and materializes the
    // directory in memfs so the creation service's post-create sanity
    // `fsPromises.stat` (Issue #854) succeeds.
    const stubRunAsUser = async (opts: RunAsUserOpts): Promise<RunAsUserResult> => {
      const tokens = Array.from(opts.command.matchAll(/'([^']*)'/g)).map((m) => m[1]);
      const wtPath = tokens.find((t) => t.includes('/worktrees/wt-'));
      if (wtPath) {
        const fs = await import('fs');
        fs.mkdirSync(wtPath, { recursive: true });
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    };
    worktreeService = new WorktreeService({ db, runAsUserImpl: stubRunAsUser });

    // `worktrees.repository_id` has an FK constraint against `repositories.id`.
    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      clonedSourceRepoPath: null,
      description: null,
    });
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('shared context (createdBy = shared user, initiatedBy = human) -> Session.isShared === true', async () => {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId: TEST_REPO_ID,
        repoName: 'test-repo',
        branch: 'feat/shared-worktree',
        useRemote: false,
        agentId: CLAUDE_CODE_AGENT_ID,
        autoStartSession: true,
        context: { createdBy: sharedUserId, initiatedBy: humanUserId },
      },
      sessionManager,
      worktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.session).toBeDefined();

    // Assert on the actual in-memory Session the real SessionManager holds,
    // not just the raw return value -- this is what a subsequent
    // `GET /api/sessions/:id` or app-sync broadcast would serve.
    const session = sessionManager.getSession(result.session!.id);
    expect(session).toBeDefined();
    expect(session!.createdBy).toBe(sharedUserId);
    expect(session!.initiatedBy).toBe(humanUserId);
    // The crucial assertion: isShared is DERIVED (not just echoed) via the
    // real SharedAccountRegistry.isSharedUserId(createdBy) predicate.
    expect(session!.isShared).toBe(true);
  });

  it('regression: personal context (createdBy = human, no initiatedBy) -> Session.isShared === false', async () => {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId: TEST_REPO_ID,
        repoName: 'test-repo',
        branch: 'feat/personal-worktree',
        useRemote: false,
        agentId: CLAUDE_CODE_AGENT_ID,
        autoStartSession: true,
        context: { createdBy: humanUserId },
      },
      sessionManager,
      worktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.session).toBeDefined();

    const session = sessionManager.getSession(result.session!.id);
    expect(session).toBeDefined();
    expect(session!.createdBy).toBe(humanUserId);
    expect(session!.initiatedBy).toBeUndefined();
    expect(session!.isShared).toBe(false);
  });
});
