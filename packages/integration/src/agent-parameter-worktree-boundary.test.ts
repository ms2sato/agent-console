/**
 * Cross-Package Boundary Test: model/reasoningEffort worker override, wire
 * schema through PTY spawn (Issue #1541)
 *
 * `CreateWorktreeBaseSchema` (`packages/shared/src/schemas/repository.ts`)
 * gained optional `model` / `reasoningEffort` fields consumed by
 * `POST /:id/worktrees`. Per pre-pr-completeness.md Q10, a shared-type field
 * crossing the server/client wire needs an integration test exercising the
 * REAL chain end to end, not just a schema unit test (which never touches
 * the wire boundary) or a route unit test (which mocks SessionManager and
 * never reaches a real WorkerManager/PTY spawn).
 *
 * This test drives the real chain:
 *
 *   real HTTP POST /api/repositories/:id/worktrees { model, reasoningEffort }
 *     -> real vValidator(CreateWorktreeRequestSchema) parse (rejects an
 *        unknown field entirely -- v.strictObject -- so a schema omission
 *        would 400 synchronously, before the fire-and-forget block runs)
 *     -> real route handler (packages/server/src/routes/worktrees.ts)
 *     -> real createWorktreeWithSession -> real SessionManager.createSession
 *        -> real WorkerLifecycleManager.createWorker's capability validation
 *        -> real WorkerManager.activateAgentWorkerPty
 *        -> real expandTemplate merge (buildAgentParameterTemplateVars)
 *        -> PTY spawn mocked ONLY at the lowest level (createMockPtyFactory)
 *
 * The route's worktree-creation pipeline is fire-and-forget (not awaited by
 * the HTTP response), so this test waits for the real
 * 'worktree-creation-completed' / 'worktree-creation-failed' broadcast
 * before asserting, then inspects the real spawned PTY command for the
 * forwarded value -- mirroring how the login shell + sentinel-injected
 * command actually reaches the PTY in production (worker-manager.ts's
 * setupWorkerEventHandlers), the same shape
 * worker-lifecycle-manager.test.ts's PTY-command assertions use.
 *
 * A real git worktree is created via a stubbed `runAsUser` (not a real
 * `sudo`/`git` invocation), mirroring the sibling
 * `worktree-shared-session-boundary.test.ts`'s harness -- this repo's own
 * established pattern for exercising `createWorktreeWithSession` for real
 * without requiring a real filesystem git repository.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { mockProcess, resetProcessMock } from '@agent-console/server/src/__tests__/utils/mock-process-helper';
import { resetGitMocks, mockGit } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { createTestApp } from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import type { RunAsUserOpts, RunAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SqliteSessionRepository } from '@agent-console/server/src/repositories/sqlite-session-repository';

const TEST_REPO_PATH = '/test/repo';
const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();
const broadcasts: unknown[] = [];

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Cross-Package Boundary: model/reasoningEffort worker override through POST /:id/worktrees (Issue #1541)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    mockGit.getRemoteUrl.mockImplementation(async () => 'git@github.com:owner/repo.git');
    mockGit.getDefaultBranch.mockImplementation(async () => 'main');
    mockGit.listWorktrees.mockImplementation(async () => {
      const captured = capturedWorktreePath;
      if (captured) {
        return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${captured}\nHEAD def456\nbranch refs/heads/feat/model-override\n`;
      }
      return `worktree ${TEST_REPO_PATH}\nHEAD abc123\nbranch refs/heads/main\n`;
    });

    // Real WorktreeService with a stubbed `runAsUser`: captures the worktree
    // path from the shell-escaped `git worktree add` command and
    // materializes the directory in memfs so the post-create sanity
    // `fsPromises.stat` succeeds. Mirrors
    // worktree-shared-session-boundary.test.ts's identical stub.
    const stubRunAsUser = async (opts: RunAsUserOpts): Promise<RunAsUserResult> => {
      const tokens = Array.from(opts.command.matchAll(/'([^']*)'/g)).map((m) => m[1]);
      const wtPath = tokens.find((t) => t?.includes('/worktrees/wt-'));
      if (wtPath) {
        capturedWorktreePath = wtPath;
        const fs = await import('fs');
        fs.mkdirSync(wtPath, { recursive: true });
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    };

    broadcasts.length = 0;
    ctx = await createTestContext({
      broadcastToApp: (msg) => { broadcasts.push(msg); },
      runAsUserImpl: stubRunAsUser,
    });
    // Real WorktreeService with the SAME stubbed runAsUser, so `git
    // worktree add` (invoked by the real route -> createWorktreeWithSession
    // chain) doesn't hit the actual OS git binary against a non-existent
    // real-filesystem path. Mirrors
    // worktree-shared-session-boundary.test.ts's identical construction.
    ctx.worktreeService = new WorktreeService({ db: ctx.db, runAsUserImpl: stubRunAsUser });

    // A bare `SingleUserMode` constructor call (vs. the `.create()` factory)
    // takes an arbitrary AuthUser object without inserting it into the
    // `users` table. `sessions.created_by REFERENCES users(id)` is FK
    // enforced (`PRAGMA foreign_keys = ON`, createDatabaseForTest), so an
    // arbitrary id makes every session-creating request fail with "FOREIGN
    // KEY constraint failed" -- silently from this test's perspective,
    // since the failure surfaces only via the async
    // worktree-creation-failed broadcast, not the synchronous 202.
    // createTestContext's DEFAULT userMode avoids this (`SingleUserMode.create`
    // upserts a real row against ctx.db first); reuse that already-real user,
    // then rebuild userMode with the SAME real user but MY ptyFactory as the
    // PTY provider (so PTY spawns are observable/inspectable, not real).
    // Non-null: SingleUserMode.authenticate() (createTestContext's default
    // userMode) always returns its cached user; the `AuthUser | null` return
    // type belongs to the general UserMode interface (MultiUserMode can
    // return null for an unresolved token).
    const realUser = ctx.userMode.authenticate(() => undefined)!;
    const testUserMode = new SingleUserMode(ptyFactory.provider, realUser);

    // SessionManager/WorkerManager close over the userMode instance they
    // were constructed with -- reassigning `ctx.userMode` afterward would
    // NOT change what PTY provider an already-built SessionManager uses.
    // Rebuild SessionManager itself, reusing every other real ctx
    // collaborator (agentManager, repositoryManager via repositoryLookup,
    // mcpTokenRegistry, etc.) so only the userMode/PTY-provider seam differs
    // from what createTestContext would have built.
    ctx.userMode = testUserMode;
    ctx.sessionManager = await SessionManager.create({
      userMode: testUserMode,
      userRepository: ctx.userRepository,
      sessionRepository: new SqliteSessionRepository(ctx.db),
      jobQueue: ctx.jobQueue,
      agentManager: ctx.agentManager,
      embeddedAgentManager: ctx.embeddedAgentManager,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
      notificationManager: ctx.notificationManager,
      annotationService: ctx.annotationService,
      interSessionMessageService: ctx.interSessionMessageService,
      repositoryLookup: {
        getRepositorySlug: (id) => ctx.repositoryManager.getRepositorySlug(id),
      },
      repositoryEnvLookup: {
        getRepositoryInfo: (id) => {
          const r = ctx.repositoryManager.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: (path) => ctx.worktreeService.getWorktreeIndexNumber(path),
      },
      runAsUserImpl: stubRunAsUser,
      pathExists: async () => true,
    });

    // Register the real capable/incapable terminal agents used below.
    capableAgentId = (await ctx.agentManager.registerAgent({
      name: 'Capable Agent',
      commandTemplate: 'capable-agent {{model:+--model}}{{effort:+--effort}}{{prompt}}',
    })).id;

    // Register through the REAL ctx.repositoryManager instance (not a
    // separate manager built from a late direct-DB write): SessionManager's
    // repositoryLookup closure was bound to THIS specific instance inside
    // createTestContext, so only a mutation of its own in-memory map (which
    // registerRepository performs, in addition to the DB write) is visible
    // to it. real memfs `.git/HEAD` + real `access()` checks (mockGit
    // handles the remote-derived slug/name).
    testRepoId = (await ctx.repositoryManager.registerRepository(TEST_REPO_PATH)).id;
  });

  let capturedWorktreePath: string | undefined;
  let capableAgentId: string;
  let testRepoId: string;

  afterEach(async () => {
    await shutdownAppContext(ctx);
    cleanupMemfs();
  });

  it('a real HTTP request with model/reasoningEffort passes wire validation and reaches the spawned PTY command', async () => {
    const app = await createTestApp(ctx);

    const res = await app.request(`/api/repositories/${testRepoId}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'task-1541-boundary',
        mode: 'custom',
        branch: 'feat/model-override',
        baseBranch: 'main',
        useRemote: false,
        agentId: capableAgentId,
        model: 'claude-opus-4-6',
        reasoningEffort: 'high',
      }),
    });

    // 202: the wire schema accepted model/reasoningEffort (a schema
    // omission would 400 here synchronously via v.strictObject, before the
    // fire-and-forget worktree-creation pipeline ever runs).
    expect(res.status).toBe(202);

    // The route's worktree creation is fire-and-forget; wait for the real
    // pipeline to finish (success broadcast) before asserting.
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0] as { type: string }).type).toBe('worktree-creation-completed');

    const sessions = ctx.sessionManager.getAllSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    const agentWorker = session.workers.find((w) => w.type === 'agent');
    expect(agentWorker).toBeDefined();

    // The real, persisted worker ROW carries the override -- read directly
    // from the disposable instance's own SQLite file (the wire responses
    // never expose model/reasoningEffort back to the caller), mirroring the
    // pattern `check-artifact-server-story-e2e.mjs` uses for the same
    // reason. The 'worktree-creation-completed' broadcast above fires after
    // `sessionManager.createSession` (including persistSession) resolves,
    // so the row is guaranteed present by this point -- no polling needed.
    const workerRow = await ctx.db
      .selectFrom('workers')
      .where('id', '=', agentWorker!.id)
      .select(['model', 'reasoning_effort'])
      .executeTakeFirstOrThrow();
    expect(workerRow.model).toBe('claude-opus-4-6');
    expect(workerRow.reasoning_effort).toBe('high');

    // The real PTY spawn/write chain: the login-shell sentinel pattern means
    // the actual command lands in the last PTY instance's written data, not
    // the spawn argv (see worker-lifecycle-manager.test.ts for the same
    // mechanism / rationale).
    await waitFor(() => {
      const lastInstance = ptyFactory.instances[ptyFactory.instances.length - 1];
      return !!lastInstance && lastInstance.writtenData.join('').includes('--model');
    });
    const lastInstance = ptyFactory.instances[ptyFactory.instances.length - 1]!;
    const written = lastInstance.writtenData.join('');
    expect(written).toContain("--model 'claude-opus-4-6'");
    expect(written).toContain("--effort 'high'");
  });

  it('rejects model at the real HTTP boundary for an agent whose template has no {{model...}} placeholder (fails, does not silently drop it)', async () => {
    const incapableAgentId = (await ctx.agentManager.registerAgent({
      name: 'Incapable Agent',
      commandTemplate: 'incapable-agent {{prompt}}',
    })).id;

    const app = await createTestApp(ctx);

    const res = await app.request(`/api/repositories/${testRepoId}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'task-1541-boundary-reject',
        mode: 'custom',
        branch: 'feat/model-rejected',
        baseBranch: 'main',
        useRemote: false,
        agentId: incapableAgentId,
        model: 'claude-opus-4-6',
      }),
    });

    // Still 202 -- the route accepts and enqueues the request synchronously;
    // the rejection happens inside the fire-and-forget pipeline and is
    // reported via a 'worktree-creation-failed' broadcast (not the HTTP
    // response).
    expect(res.status).toBe(202);

    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts).toHaveLength(1);
    const failure = broadcasts[0] as { type: string; error: string };
    expect(failure.type).toBe('worktree-creation-failed');
    expect(failure.error).toContain('model');

    // No session was ever created for the rejected request -- the real,
    // durable observable, not merely the broadcast text.
    expect(ctx.sessionManager.getAllSessions()).toHaveLength(0);
  });
});
