/**
 * Client-Server Boundary Test: DELETE worktree route resolves the
 * worktree's OWNER, not the requester (Issue #1868).
 *
 * Also covers Issue #1295's errorType -> HTTP status split through this
 * same real chain: (A) the check could not run -> 503 (precheck-failed),
 * distinct from (D) the check ran and found a PR -> 409 (open-pr). Closes
 * the preflight "integration test gap" warning this PR's change to the
 * route's error mapping would otherwise re-trigger.
 *
 * Closes the preflight "integration test gap" warning for
 * `packages/server/src/routes/worktrees.ts`. Exercises the REAL chain:
 *
 *   real DELETE /api/repositories/:id/worktrees/* route
 *     -> real SessionManager.resolveWorktreeOwnerUsername (live AND
 *        persisted/paused rows, through the real DB)
 *     -> real worktree-deletion-service.ts
 *     -> the findOpenPullRequest seam (a fake capturing its args, not a
 *        module-level mock)
 *
 * Q13 recorded proxy (pre-pr-completeness.md): the WorktreeService methods
 * that actually invoke git (isWorktreeOf, listWorktrees, createWorktree,
 * removeWorktree) are stubbed. This sits upstream of and outside the
 * identity-resolution chain under test -- git's own worktree-add/remove
 * contract is pinned by worktree-service.test.ts. A real scratch git repo
 * cannot be driven reliably in this process: importing any sibling file
 * that uses test-utils.ts's setupTestEnvironment permanently swaps
 * node:fs/fs-promises for an in-memory simulation and lib/git.js for a
 * fixed mock, for the rest of this bun test process (bun:test's
 * mock.module is process-global and irreversible). A real `git worktree
 * add`/`remove` against a path that only exists in that simulation fails
 * with ENOENT. Everything else here is real: the route, SessionManager
 * (live and paused/persisted lookups), the deletion service, the
 * repository manager, and the user repository.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
// `node:fs` is deliberately imported AFTER test-utils (which, via its own
// static import of mock-fs-helper.js, registers `mock.module('node:fs', ...)`
// at that module's load time). Per testing.md's "Static import order
// determines which mock a dependency binds to", this import resolves to the
// SAME memfs-backed volume `setupMemfs` operates on -- no separate `memfs`
// package dependency is needed in this package just to reach `vol.mkdirSync`.
import * as fsSync from 'node:fs';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import type { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';
import { getRepositoriesDir } from '@agent-console/server/src/lib/config';
import type { Worktree } from '@agent-console/shared';

const TEST_REPO_PATH = '/test/repo-1868';

describe('Client-Server Boundary: DELETE worktree route resolves the owner, not the requester (Issue #1868)', () => {
  let ctx: AppContext;
  let requesterUsername: string;
  let repoId: string;
  let worktreeRegistry: Map<string, { branch: string; index: number }>;

  const mockRemoveWorktree = mock<
    (repoPath: string, worktreePath: string, force: boolean, requestUsername?: string | null) =>
      Promise<{ success: boolean; error?: string }>
  >(async () => ({ success: true }));
  const mockExecuteHookCommand = mock<
    (
      command: string,
      worktreePath: string,
      vars: { worktreeNum: number; branch: string; repo: string },
      requestUsername?: string | null,
    ) => Promise<{ success: boolean; output?: string; error?: string }>
  >(async () => ({ success: true }));

  function fakeWorktreeService(): WorktreeService {
    const stub: Partial<WorktreeService> = {
      verifyRepoAccessible: async () => undefined,
      ensureRepoHasCommits: async () => undefined,
      isWorktreeOf: async (_repoPath: string, worktreePath: string) =>
        worktreeRegistry.has(worktreePath),
      listWorktrees: async (_repoPath: string, repositoryId: string): Promise<Worktree[]> =>
        Array.from(worktreeRegistry.entries()).map(([p, info]) => ({
          path: p,
          branch: info.branch,
          isMain: false,
          repositoryId,
          index: info.index,
        })),
      createWorktree: async (
        _repoPath: string,
        branch: string,
        _repositoryId: string,
      ): Promise<{ worktreePath: string; index?: number }> => {
        const index = worktreeRegistry.size + 1;
        const worktreePath = path.join(getRepositoriesDir(), 'test-repo-1868', 'worktrees', `wt-${index}`);
        fsSync.mkdirSync(worktreePath, { recursive: true });
        worktreeRegistry.set(worktreePath, { branch, index });
        return { worktreePath, index };
      },
      removeWorktree: mockRemoveWorktree,
      removeOrphanedWorktree: async () => undefined,
      executeHookCommand: mockExecuteHookCommand,
    };
    return stub as WorktreeService;
  }

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });

    worktreeRegistry = new Map();
    mockRemoveWorktree.mockClear();
    mockExecuteHookCommand.mockClear();

    // Issue #1886: hermetic PtyProvider -- this suite's fixture cwd does not
    // exist on disk, and the configured default (bun-terminal) throws
    // ENOENT on a missing cwd where the legacy bunPtyProvider silently
    // tolerated it (production handling tracked separately, #1892).
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    requesterUsername = os.userInfo().username;

    const repo = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    repoId = repo.id;
    await ctx.repositoryManager.updateRepository(repoId, { cleanupCommand: 'echo test' });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  /**
   * Build a fresh app per request, matching the pattern established in
   * `packages/server/src/routes/__tests__/worktrees.test.ts`'s own
   * per-`it()` overrides -- avoids any ambiguity about which of two stacked
   * `app.use('*', ...)` middlewares Hono would honor for a given request.
   */
  function buildApp(overrides: Partial<AppContext> = {}): Hono<AppBindings> {
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', { ...ctx, worktreeService: fakeWorktreeService(), ...overrides });
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
    return app;
  }

  async function createFixtureWorktree(opts: {
    branch: string;
    createdBy?: string;
    autoStartSession?: boolean;
  }): Promise<{ worktreePath: string; sessionId?: string }> {
    const result = await createWorktreeWithSession(
      {
        repoPath: TEST_REPO_PATH,
        repoId,
        repoName: 'test-repo-1868',
        branch: opts.branch,
        useRemote: false,
        agentId: CLAUDE_CODE_AGENT_ID,
        autoStartSession: opts.autoStartSession ?? true,
        context: opts.createdBy ? { createdBy: opts.createdBy } : undefined,
      },
      ctx.sessionManager,
      fakeWorktreeService(),
    );
    if (!result.success) {
      throw new Error(`fixture creation failed: ${result.error}`);
    }
    return { worktreePath: result.worktree!.path, sessionId: result.session?.id };
  }

  function makeFakeFindOpenPullRequest(behavior: 'throw' | 'null'): {
    fn: (branch: string, cwd: string, requestUsername: string | null) => Promise<{ number: number; title: string } | null>;
    capturedIdentities: (string | null)[];
  } {
    const capturedIdentities: (string | null)[] = [];
    const fn = async (_branch: string, _cwd: string, requestUsername: string | null) => {
      capturedIdentities.push(requestUsername);
      if (behavior === 'throw') {
        throw new Error('gh not found');
      }
      return null;
    };
    return { fn, capturedIdentities };
  }

  it('(A) persisted (paused) owner: open-PR check fails closed, naming the owner -- 503 (precheck-failed), removal never attempted', async () => {
    const sharedUser = await ctx.userRepository.upsertByOsUid(987601, 'shared1', '/home/shared1');
    const { worktreePath, sessionId } = await createFixtureWorktree({
      branch: 'issue-1868-a',
      createdBy: sharedUser.id,
    });
    expect(sessionId).toBeDefined();

    const paused = await ctx.sessionManager.pauseSession(sessionId!);
    expect(paused).toBe(true);
    // Confirm it's really gone from the LIVE map (forces resolveWorktreeOwnerUsername's PAUSED branch).
    expect(ctx.sessionManager.getSession(sessionId!)).toBeUndefined();

    const { fn, capturedIdentities } = makeFakeFindOpenPullRequest('throw');
    const app = buildApp({ findOpenPullRequest: fn });

    const encodedPath = encodeURIComponent(worktreePath);
    const res = await app.request(`/api/repositories/${repoId}/worktrees/${encodedPath}`, { method: 'DELETE' });

    // The check could not run (gh auth / infra failure as the owner) is
    // not "a PR was found" -- 503, distinct from the 409 in (D) below.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('as shared1');
    expect(body.error).toMatch(/did not run/);
    expect(body.error).not.toContain('has open PR #');
    expect(capturedIdentities).toEqual(['shared1']);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('(D) persisted (paused) owner: open PR found -- 409, distinct from the precheck-failed 503 in (A)', async () => {
    const sharedUser = await ctx.userRepository.upsertByOsUid(987603, 'shared1', '/home/shared1');
    const { worktreePath, sessionId } = await createFixtureWorktree({
      branch: 'issue-1295-d',
      createdBy: sharedUser.id,
    });
    expect(sessionId).toBeDefined();

    const paused = await ctx.sessionManager.pauseSession(sessionId!);
    expect(paused).toBe(true);

    const capturedIdentities: (string | null)[] = [];
    const fn = async (_branch: string, _cwd: string, requestUsername: string | null) => {
      capturedIdentities.push(requestUsername);
      return { number: 77, title: 'Some PR' };
    };
    const app = buildApp({ findOpenPullRequest: fn });

    const encodedPath = encodeURIComponent(worktreePath);
    const res = await app.request(`/api/repositories/${repoId}/worktrees/${encodedPath}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('open PR #77');
    expect(body.error).not.toMatch(/did not run/);
    expect(capturedIdentities).toEqual(['shared1']);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('(B) live owner: removal and cleanup command run as the owner, not the requester', async () => {
    const sharedUser = await ctx.userRepository.upsertByOsUid(987602, 'shared1', '/home/shared1');
    const { worktreePath, sessionId } = await createFixtureWorktree({
      branch: 'issue-1868-b',
      createdBy: sharedUser.id,
    });
    expect(sessionId).toBeDefined();

    const { fn } = makeFakeFindOpenPullRequest('null');
    const app = buildApp({ findOpenPullRequest: fn });

    const encodedPath = encodeURIComponent(worktreePath);
    const res = await app.request(`/api/repositories/${repoId}/worktrees/${encodedPath}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveWorktree.mock.calls[0]?.[3]).toBe('shared1');
    expect(mockExecuteHookCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteHookCommand.mock.calls[0]?.[3]).toBe('shared1');
    expect(ctx.sessionManager.getSession(sessionId!)).toBeUndefined();
  });

  it('(C) no owning session: falls back to the requester', async () => {
    const { worktreePath } = await createFixtureWorktree({
      branch: 'issue-1868-c',
      autoStartSession: false,
    });

    const { fn } = makeFakeFindOpenPullRequest('null');
    const app = buildApp({ findOpenPullRequest: fn });

    const encodedPath = encodeURIComponent(worktreePath);
    const res = await app.request(`/api/repositories/${repoId}/worktrees/${encodedPath}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockRemoveWorktree.mock.calls[0]?.[3]).toBe(requesterUsername);
    expect(mockExecuteHookCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteHookCommand.mock.calls[0]?.[3]).toBe(requesterUsername);
  });
});
