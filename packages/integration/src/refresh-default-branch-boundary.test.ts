/**
 * Client-Server Boundary Test: POST /api/repositories/:id/refresh-default-branch
 * returns a body the client's wire schema accepts.
 *
 * The client parses this response through the STRICT
 * `RefreshDefaultBranchResponseSchema` (`v.strictObject({ defaultBranch })`),
 * so a field added to the route's body would turn a working call into a
 * runtime throw in the browser, and nothing on either side alone would notice:
 * the route's own tests assert `defaultBranch`, the client's unit tests inject
 * a hand-written body. This test runs the REAL route (real
 * `RepositoryManager`, real `WorktreeService.refreshDefaultBranch`) and parses
 * what it actually sent. Only git itself is the recorded proxy
 * (`mockGit.refreshDefaultBranch`): it sits upstream of the response shape
 * under test.
 *
 * Reach, measured: adding a second field to the route's `c.json({ defaultBranch })`
 * makes both tests below fail (the exact-keys assertion and the strict parse).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { mockGit } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import { RefreshDefaultBranchResponseSchema } from '@agent-console/shared';

const TEST_REPO_PATH = '/test/repo-refresh-default-branch';

describe('Client-Server Boundary: refresh-default-branch response matches the wire schema', () => {
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

  async function refresh(): Promise<{ status: number; body: unknown }> {
    const res = await app.request(`/api/repositories/${repoId}/refresh-default-branch`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  }

  it('sends exactly { defaultBranch }, which the strict client schema parses to the same value', async () => {
    mockGit.refreshDefaultBranch.mockImplementationOnce(() => Promise.resolve('develop'));

    const { status, body } = await refresh();

    expect(status).toBe(200);
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['defaultBranch']);
    expect(v.parse(RefreshDefaultBranchResponseSchema, body)).toEqual({ defaultBranch: 'develop' });
  });

  it('control: the strict schema does reject the same body with one extra field', async () => {
    mockGit.refreshDefaultBranch.mockImplementationOnce(() => Promise.resolve('main'));

    const { body } = await refresh();

    expect(v.safeParse(RefreshDefaultBranchResponseSchema, { ...(body as object), extra: true }).success).toBe(false);
    expect(v.safeParse(RefreshDefaultBranchResponseSchema, body).success).toBe(true);
  });
});
