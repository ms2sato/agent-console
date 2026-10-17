/**
 * Client-Server Boundary Test: the embedded-agent definition, job and system
 * health fetchers that parse their response through a strict wire schema
 * (#1367 pass 5).
 *
 * `fetchEmbeddedAgents`, `fetchJobs`, `fetchJobStats` and `fetchSystemHealth`
 * are driven through the real routes (the fetch bridge forwards the client's
 * request to the real Hono app), so a body the server really produces is
 * parsed by the client's real strict schema. The builtin `claude-sdk`
 * definition is served by the list route without ever being created through a
 * form, which is why it is asserted explicitly.
 *
 * The last case is the polarity control: a bridge response that gains one
 * top-level key makes `fetchJobStats` reject. Before the parse existed the
 * extra key passed straight through, so this case fails on that client.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import {
  fetchEmbeddedAgents,
  createEmbeddedAgent,
  fetchJobs,
  fetchJobStats,
  fetchSystemHealth,
} from '@agent-console/client/src/lib/api';
import { JOB_TYPES } from '@agent-console/shared';
import { createFetchBridge } from './test-utils';

describe('Client-Server Boundary: strict wire schemas on the definition, job and health fetchers', () => {
  let ctx: AppContext;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({});
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge?.restore();
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('fetchEmbeddedAgents returns the builtin claude-sdk definition and a created openai-api one, strictly parsed', async () => {
    const created = await createEmbeddedAgent({
      engine: 'openai-api',
      name: 'Ollama qwen3',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
    });

    const { embeddedAgents } = await fetchEmbeddedAgents();

    const builtin = embeddedAgents.find((agent) => agent.isBuiltIn);
    expect(builtin?.engine).toBe('claude-sdk');
    const mine = embeddedAgents.find((agent) => agent.id === created.embeddedAgent.id);
    expect(mine?.engine).toBe('openai-api');
    expect(mine?.name).toBe('Ollama qwen3');
  });

  it('fetchJobs returns one enqueued job parsed with total 1, and fetchJobStats parses the counts', async () => {
    const jobId = await ctx.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, { sessionId: 'no-such-session' });

    const result = await fetchJobs();

    expect(result.total).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(jobId);
    expect(result.jobs[0].type).toBe(JOB_TYPES.CLEANUP_SESSION_OUTPUTS);

    const stats = await fetchJobStats();
    expect(stats.pending + stats.processing + stats.completed + stats.stalled).toBe(1);
  });

  it('fetchSystemHealth parses the real health body', async () => {
    const health = await fetchSystemHealth();
    expect(typeof health.webhookSecretConfigured).toBe('boolean');
    expect(health.appUrl === null || typeof health.appUrl === 'string').toBe(true);
  });

  it('fetchJobStats rejects a response that gains an extra top-level key (parsing really happens)', async () => {
    const forwardingFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await forwardingFetch(input, init);
        const body = (await res.json()) as object;
        return new Response(JSON.stringify({ ...body, extra: true }), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      { preconnect: () => {} },
    ) as typeof fetch;

    try {
      await expect(fetchJobStats()).rejects.toThrow();
    } finally {
      globalThis.fetch = forwardingFetch;
    }
  });
});
