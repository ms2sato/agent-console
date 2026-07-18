/**
 * Client-Server Boundary Test: `restore-info` WorkerServerMessage (Transcript
 * Restore, Issue #1123, CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the new `restore-info`
 * `WorkerServerMessage` variant. `WorkerServerMessage` as a whole has no
 * existing valibot union to extend (server sends raw typed literals; the
 * client does an unchecked `as WorkerServerMessage` cast), so this test
 * exercises the standalone `RestoreInfoMessageSchema`
 * (packages/shared/src/schemas/session.ts) against the REAL value
 * `EmbeddedAgentWorkerService.getRestoreInfo` produces after a genuine
 * activation -> restore cycle over a real loop subprocess -- not a
 * hand-constructed fixture -- so a server/schema field-shape drift (a
 * forgotten field, a renamed field, a type mismatch) fails this test instead
 * of silently reaching the client.
 *
 * This reuses embedded-agent-e2e.test.ts's real-subprocess / real-MCP /
 * stub-provider harness (this repo's established "E2E" pattern, which itself
 * exercises the server-side service layer directly rather than a live
 * WebSocket client -- see that file's header comment), trimmed to a single
 * plain-text turn (no tool calls needed) across TWO activation cycles: the
 * first activation persists a transcript, the second activation (after a
 * graceful deactivate) restores it.
 *
 * Spec: docs/design/embedded-agent-worker.md "Transcript Restore" § UI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v from 'valibot';
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

import { RestoreInfoMessageSchema, EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';

const USER_TEXT = 'say hi';
const REPLY_TEXT = 'hello there';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A single plain-text turn: no tool calls, so activation/restore stays maximally simple. */
function plainTextSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: REPLY_TEXT }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

function hasIdleAfterAssistant(events: EmbeddedAgentStreamEvent[]): boolean {
  let sawAssistant = false;
  for (const e of events) {
    if (e.type === 'assistant-message') sawAssistant = true;
    if (sawAssistant && e.type === 'state' && e.state === 'idle') return true;
  }
  return false;
}

describe('Client-Server Boundary: restore-info WorkerServerMessage (Transcript Restore #1123)', () => {
  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;

  // Same happy-dom caveat as embedded-agent-e2e.test.ts: the loop
  // subprocess's real HTTP calls to /mcp need real Response/Headers.
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
        for (const s of ctx.sessionManager.getAllSessions()) {
          for (const w of s.workers) {
            if (w.type === 'embedded-agent' && w.activated) {
              await ctx.sessionManager.deactivateEmbeddedAgentWorker(s.id, w.id).catch(() => {});
            }
          }
        }
      } catch {
        // best-effort
      }
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

  it(
    'a real restore cycle produces a getRestoreInfo() value that parses via RestoreInfoMessageSchema, for BOTH the triggering connection and a re-delivery lookup',
    async () => {
      stubServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            return new Response(plainTextSse(), { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      let mcpBaseUrl = '';
      ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
      const owner = await ctx.userRepository.upsertByOsUid(54324, 'owner4', '/home/owner4');

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

      realCwd = path.join(os.tmpdir(), `ac-embedded-restore-boundary-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      const createRes = await app.fetch(
        new Request('http://localhost/api/embedded-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Stub local LLM (restore boundary)',
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
      const sessionId = session.id;
      const worker = await ctx.sessionManager.createWorker(sessionId, {
        type: 'embedded-agent',
        embeddedAgentId,
      });
      expect(worker).not.toBeNull();
      const workerId = worker!.id;

      const readEvents = async (): Promise<EmbeddedAgentStreamEvent[]> => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
        const events: EmbeddedAgentStreamEvent[] = [];
        if (hist) {
          for (const line of hist.data.split('\n')) {
            if (line.trim() === '') continue;
            let json: unknown;
            try {
              json = JSON.parse(line);
            } catch {
              continue;
            }
            const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, json);
            if (parsed.success) events.push(parsed.output);
          }
        }
        return events;
      };

      const waitForIdleAfterAssistant = async (deadlineMs: number): Promise<void> => {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const events = await readEvents();
          const fatal = events.find((e) => e.type === 'fatal');
          if (fatal && fatal.type === 'fatal') throw new Error(`loop emitted fatal: ${fatal.message}`);
          const turnErr = events.find((e) => e.type === 'turn-error');
          if (turnErr && turnErr.type === 'turn-error') throw new Error(`loop emitted turn-error: ${turnErr.message}`);
          if (hasIdleAfterAssistant(events)) return;
          await delay(200);
        }
        throw new Error('Timed out waiting for idle-after-assistant');
      };

      // --- First activation: nothing to restore yet, sends one message, then deactivates. ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
      expect(ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId)).toBeNull();

      const sendRes = await ctx.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, USER_TEXT);
      expect(sendRes.ok).toBe(true);
      await waitForIdleAfterAssistant(30_000);

      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);

      // --- Second activation: the persisted transcript from the first
      // incarnation is now non-empty, so restore fires for real. ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

      const info = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(info).not.toBeNull();

      // The exact wire payload shape routes.ts builds: `{ type: 'restore-info', ...info }`.
      const wirePayload = JSON.parse(JSON.stringify({ type: 'restore-info', ...info }));
      const parsed = v.safeParse(RestoreInfoMessageSchema, wirePayload);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`);
      }
      expect(parsed.output.messageCount).toBeGreaterThan(0);
      expect(parsed.output.repairedToolCallIds).toEqual([]);
      expect(typeof parsed.output.epoch).toBe('number');

      // --- Bootstrap re-delivery equivalent: a SECOND lookup (as a second WS
      // connection's onOpen would perform) returns the SAME restorable shape,
      // also schema-valid. ---
      const infoAgain = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAgain).not.toBeNull();
      const wirePayloadAgain = JSON.parse(JSON.stringify({ type: 'restore-info', ...infoAgain }));
      const parsedAgain = v.safeParse(RestoreInfoMessageSchema, wirePayloadAgain);
      expect(parsedAgain.success).toBe(true);
      if (parsedAgain.success) {
        expect(parsedAgain.output.messageCount).toBe(parsed.output.messageCount);
        expect(parsedAgain.output.epoch).toBe(parsed.output.epoch);
      }
    },
    60_000,
  );
});
