/**
 * TEMPORARY diagnostic for Issue #1225. Removed before PR finalization.
 * Delta-debug reduction of embedded-agent-restore-info-boundary.test.ts:
 * keeps everything through session+worker creation, but never calls
 * activateEmbeddedAgentWorker (no real subprocess spawn at all).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import {
  createTestContext,
  shutdownAppContext,
  type AppContext,
  type AppBindings,
} from '@agent-console/server/src/app-context';
import { api } from '@agent-console/server/src/routes/api';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('Issue #1225 reduce -- ctx + Bun.serve + worker creation, NO activation', () => {
  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;

  beforeAll(async () => {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });

  afterAll(() => {
    if (!GlobalRegistrator.isRegistered) {
      GlobalRegistrator.register();
    }
  });

  beforeEach(async () => {
    await setupTestEnvironment();
  });

  afterEach(async () => {
    if (ctx) {
      try {
        await shutdownAppContext(ctx);
      } catch {
        // best-effort
      }
      ctx = undefined;
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    appServer = undefined;
    try {
      stubServer?.stop(true);
    } catch {
      // best-effort
    }
    stubServer = undefined;
    try {
      await cleanupTestEnvironment();
    } catch {
      // best-effort
    }
    if (realCwd) {
      Bun.spawnSync(['rm', '-rf', realCwd]);
      realCwd = undefined;
    }
  });

  it('creates ctx, real servers, agent, session, worker -- never activates', async () => {
    stubServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          return new Response(
            sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        return new Response('not found', { status: 404 });
      },
    });
    const stubBaseUrl = `http://localhost:${stubServer.port}`;

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
    const owner = await ctx.userRepository.upsertByOsUid(54325, 'owner5', '/home/owner5');

    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    const mcpApp = createMcpApp({
      sessionManager: ctx.sessionManager,
      repositoryManager: ctx.repositoryManager,
      agentManager: ctx.agentManager,
      timerManager: ctx.timerManager,
      conditionalWakeupManager: ctx.conditionalWakeupManager,
      interactiveProcessManager: ctx.interactiveProcessManager,
      worktreeService: ctx.worktreeService,
      annotationService: ctx.annotationService,
      interSessionMessageService: ctx.interSessionMessageService,
      suggestSessionMetadata: ctx.suggestSessionMetadata,
      createWorktreeWithSession,
      deleteWorktree,
      userRepository: ctx.userRepository,
      broadcastToApp: ctx.broadcastToApp,
      fetchPullRequestUrl: ctx.fetchPullRequestUrl,
      findOpenPullRequest: ctx.findOpenPullRequest,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
    });
    app.route('', mcpApp);

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    realCwd = path.join(os.tmpdir(), `ac-1225-reduce-no-activation-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);

    const createRes = await app.fetch(
      new Request('http://localhost/api/embedded-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Stub local LLM (1225 reduce)',
          provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'stub-model' },
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { embeddedAgent: { id: string } };
    const embeddedAgentId = createBody.embeddedAgent.id;

    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: realCwd, agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    expect(worker).not.toBeNull();
  });
});
