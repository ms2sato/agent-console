/**
 * Cross-Package Boundary Test: embedded-agent worktree creation (Issue #1038)
 *
 * Verifies the full server-side chain for `createWorktreeWithSession` with an
 * `embeddedAgentId` selection: schema-level mutual exclusivity is unit-tested
 * elsewhere (packages/shared, worktrees.test.ts), but this test exercises the
 * REAL cross-package pipeline end-to-end at the service layer —
 * `createWorktreeWithSession` -> `WorktreeService` (real git-mock-backed
 * worktree creation) -> `SessionManager.createSession` -> `WorkerLifecycleManager
 * .createWorker` — and confirms:
 *
 *   - An `embeddedAgentId` selection creates an `embedded-agent` initial
 *     worker (deactivated, Phase 1) instead of a terminal `agent` worker.
 *   - The pre-existing `agentId` (terminal-agent) path through this same
 *     chain is unaffected (regression/polarity check).
 *   - A dangling `embeddedAgentId` (no matching persisted definition) fails
 *     the whole worktree creation with a rollback, surfacing the validation
 *     error from `WorkerLifecycleManager.createWorker`.
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
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import type { RunAsUserOpts, RunAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';

const TEST_CONFIG_DIR = '/test/config';
const TEST_REPO_PATH = '/test/repo';
const TEST_REPO_ID = 'repo-1';
const ptyFactory = createMockPtyFactory();

describe('createWorktreeWithSession: embedded-agent worker creation boundary', () => {
  let sessionManager: SessionManager;
  let worktreeService: WorktreeService;
  let embeddedAgentManager: EmbeddedAgentManager;
  let testJobQueue: JobQueue;
  let embeddedAgentId: string;

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
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      annotationService: new AnnotationService(),
      repositoryLookup: {
        getRepositorySlug: (id) => (id === TEST_REPO_ID ? 'test-repo' : undefined),
      },
      repositoryEnvLookup: {
        getRepositoryInfo: () => undefined,
        getWorktreeIndexNumber: async () => 0,
      },
    });

    // Real WorktreeService with a stubbed `runAsUser` (single-user mode never
    // elevates, but `createWorktree` always routes `git worktree add` through
    // this seam regardless). The stub mirrors the pattern established in
    // mcp-server.test.ts's `delegate_to_worktree` describe block: it captures
    // the worktree path from the shell-escaped command and materializes the
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

    // `worktrees.repository_id` has an FK constraint against `repositories.id`
    // (see connection.ts migration). `WorktreeService.createWorktree` inserts
    // a worktree row keyed on `repoId`, so a repository row must exist even
    // though this test drives `createWorktreeWithSession` directly (bypassing
    // RepositoryManager / the HTTP route, which would normally seed this).
    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      clonedSourceRepoPath: null,
      description: null,
    });

    // Persist one embedded-agent definition via the real manager (mirrors the
    // embedded-agent-e2e.test.ts pattern, minus the HTTP round-trip since this
    // test drives the service layer directly).
    const def = await embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Stub embedded agent',
        provider: { baseUrl: 'http://localhost:9/v1', model: 'stub-model' },
      },
      'creator-user-id',
    );
    embeddedAgentId = def.id;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('embeddedAgentId selection creates a deactivated embedded-agent initial worker, no terminal agent worker', async () => {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId: TEST_REPO_ID,
        repoName: 'test-repo',
        branch: 'feat/embedded-agent-wt',
        useRemote: false,
        embeddedAgentId,
        autoStartSession: true,
      },
      sessionManager,
      worktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.session).toBeDefined();

    const session = sessionManager.getSession(result.session!.id);
    expect(session).toBeDefined();

    const embeddedWorker = session!.workers.find((w) => w.type === 'embedded-agent');
    expect(embeddedWorker).toBeDefined();
    expect(embeddedWorker?.type === 'embedded-agent' && embeddedWorker.embeddedAgentId).toBe(embeddedAgentId);
    expect(embeddedWorker?.type === 'embedded-agent' && embeddedWorker.activated).toBe(false);

    expect(session!.workers.some((w) => w.type === 'agent')).toBe(false);
    expect(session!.workers.some((w) => w.type === 'git-diff')).toBe(true);
    expect(session!.workers).toHaveLength(2);
  });

  it('regression: agentId (no embeddedAgentId) still creates a terminal agent initial worker', async () => {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId: TEST_REPO_ID,
        repoName: 'test-repo',
        branch: 'feat/terminal-agent-wt',
        useRemote: false,
        agentId: CLAUDE_CODE_AGENT_ID,
        autoStartSession: true,
      },
      sessionManager,
      worktreeService,
    );

    expect(result.success).toBe(true);
    expect(result.session).toBeDefined();

    const session = sessionManager.getSession(result.session!.id);
    expect(session).toBeDefined();

    const agentWorker = session!.workers.find((w) => w.type === 'agent');
    expect(agentWorker).toBeDefined();
    expect(agentWorker?.type === 'agent' && agentWorker.agentId).toBe(CLAUDE_CODE_AGENT_ID);

    expect(session!.workers.some((w) => w.type === 'embedded-agent')).toBe(false);
    expect(session!.workers.some((w) => w.type === 'git-diff')).toBe(true);
    expect(session!.workers).toHaveLength(2);
  });

  it('a dangling embeddedAgentId (no persisted definition) fails worktree creation with a rollback', async () => {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId: TEST_REPO_ID,
        repoName: 'test-repo',
        branch: 'feat/dangling-embedded-agent-wt',
        useRemote: false,
        embeddedAgentId: 'nonexistent-embedded-agent-id',
        autoStartSession: true,
      },
      sessionManager,
      worktreeService,
    );

    expect(result.success).toBe(false);
    expect(result.session).toBeUndefined();
    expect(result.error).toContain('Embedded agent definition not found');
    expect(result.error).toContain('nonexistent-embedded-agent-id');
  });
});
