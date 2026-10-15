/**
 * Client-Server Boundary Test: POST /api/repositories/clone carries the `bare`
 * flag from the request body to the clone service.
 *
 * Runs the REAL route (real `CloneRepositoryRequestSchema` strictObject
 * validation, real `api` router, real app context). Only `enqueueClone` is
 * replaced with a spy: it sits downstream of the wire boundary under test and
 * would otherwise start a real `git clone`. A schema that dropped or renamed
 * `bare`, or a route that forgot to forward it, fails here and in no unit test
 * on either side alone.
 *
 * Reach, measured (each mutation applied alone): removing `bare` from the
 * schema fails only the "{ url, bare: true } is accepted" test; removing the
 * route's `bare: body.bare` fails only that same test. The 400 test passes in
 * both mutated worlds (an unknown key is also rejected), so it pins the
 * rejection outcome, not the boolean typing; the typing is pinned by the
 * schema's own test in packages/shared.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';

const URL = 'https://github.com/org/repo.git';

describe('Client-Server Boundary: POST /api/repositories/clone `bare` flag', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let enqueueClone: ReturnType<typeof spyOn<AppContext['repositoryCloneService'], 'enqueueClone'>>;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({});
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    enqueueClone = spyOn(ctx.repositoryCloneService, 'enqueueClone').mockResolvedValue('job-1');

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    enqueueClone.mockRestore();
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function clone(body: unknown): Promise<Response> {
    return app.request('/api/repositories/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('{ url, bare: true } is accepted (202) and reaches enqueueClone with bare: true', async () => {
    const res = await clone({ url: URL, bare: true });

    expect(res.status).toBe(202);
    expect(enqueueClone).toHaveBeenCalledTimes(1);
    expect(enqueueClone.mock.calls[0][0].bare).toBe(true);
    expect(enqueueClone.mock.calls[0][0].url).toBe(URL);
  });

  it('control: { url } alone is accepted and reaches enqueueClone with bare undefined', async () => {
    const res = await clone({ url: URL });

    expect(res.status).toBe(202);
    expect(enqueueClone.mock.calls[0][0].bare).toBeUndefined();
  });

  it('{ url, bare: "yes" } is rejected with 400 by the strict schema, and the service is never called', async () => {
    const res = await clone({ url: URL, bare: 'yes' });

    expect(res.status).toBe(400);
    expect(enqueueClone).toHaveBeenCalledTimes(0);
  });
});
