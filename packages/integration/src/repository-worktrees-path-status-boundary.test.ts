/**
 * Client-Server Boundary Test: GET /api/repositories/:id/worktrees carries the
 * listing's `pathStatus` (Refs #783, option C).
 *
 * Exercises the REAL chain: the real GET route -> the real WorktreeService
 * (its listing `catch` and the real `classifyRepositoryPath`) -> the
 * response JSON the dashboard parses. Only git itself is the recorded proxy
 * (`mockGit.listWorktrees`): it sits upstream of the status under test, and
 * git's porcelain contract is pinned by worktree-service.test.ts. The
 * directory state is driven through the in-memory fs the whole suite shares,
 * so `chmod 000` (mode bits) is covered by the real-fs unit test of
 * `classifyRepositoryPath`, not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { mockGit } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
// Imported AFTER test-utils so it binds to the same memfs volume setupMemfs
// operates on (testing.md "Static import order determines which mock...").
import * as fsSync from 'node:fs';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import type { WorktreesResponse } from '@agent-console/shared';

const TEST_REPO_PATH = '/test/repo-path-status';

describe('Client-Server Boundary: worktree listing carries pathStatus (Refs #783)', () => {
  let ctx: AppContext;
  let repoId: string;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({ [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main' });
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    repoId = (await ctx.repositoryManager.registerRepository(TEST_REPO_PATH)).id;

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function getListing(): Promise<WorktreesResponse> {
    const res = await app.request(`/api/repositories/${repoId}/worktrees`, { method: 'GET' });
    expect(res.status).toBe(200);
    return (await res.json()) as WorktreesResponse;
  }

  it('reports pathStatus "ok" with the main worktree for a healthy repository', async () => {
    mockGit.listWorktrees.mockImplementation(() =>
      Promise.resolve(`worktree ${TEST_REPO_PATH}\nHEAD abc\nbranch refs/heads/main\n`));

    const body = await getListing();

    expect(body.pathStatus).toBe('ok');
    expect(body.worktrees.map((w) => w.path)).toEqual([TEST_REPO_PATH]);
  });

  it('reports pathStatus "missing" with an empty list once the directory is gone', async () => {
    fsSync.rmSync(TEST_REPO_PATH, { recursive: true });
    mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('not a git repository')));

    const body = await getListing();

    expect(body).toEqual({ worktrees: [], pathStatus: 'missing' });
  });

  it('reports pathStatus "ok" with an empty list when git fails on a readable directory', async () => {
    mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('git exploded')));

    const body = await getListing();

    expect(body).toEqual({ worktrees: [], pathStatus: 'ok' });
  });
});
