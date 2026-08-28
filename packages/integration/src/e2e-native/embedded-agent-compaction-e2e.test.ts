/**
 * E2E (shipping-path) test for Compaction (Issue #1401).
 *
 * This is `embedded-agent-sdk-engine.md` §7's verification floor, replacing
 * the retired handoff E2E from PR #1349 and built on
 * `embedded-agent-e2e.test.ts`'s construction: a REAL loop subprocess, a REAL
 * app server, a scripted stub OpenAI-compatible provider over real HTTP, and
 * no mocks of the loop itself.
 *
 * What it proves that no unit test can:
 *
 *   1. The auto threshold fires from a REAL usage reading. The stub provider
 *      reports a `usage.prompt_tokens` above the definition's own
 *      `contextWindowTokens * threshold`, and the loop -- not a test double --
 *      decides to compact.
 *   2. The `context-compacted` marker survives the whole wire: loop stdout ->
 *      the server's KNOWN_EVENT_TYPES gate -> `EmbeddedAgentEventSchema`
 *      validation -> persisted append -> history replay -> the client's own
 *      `EmbeddedAgentStreamEventSchema` parser. (That gate is not a
 *      hypothetical layer: the event was in fact missing from it while this
 *      feature was being built, and a boundary test is what caught it.)
 *   3. **The conversation continues.** This is the property that separates
 *      compaction from handoff: after the boundary, the SAME worker takes
 *      another user message and answers it, with no reactivation and no new
 *      session -- and the provider's own view of that follow-up request shows
 *      a conversation whose head is the summary rather than the original
 *      history.
 *
 * NOTE: this file runs under a SEPARATE `bun test` invocation (see
 * `./setup-native.ts`) that never registers happy-dom.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v from 'valibot';
import { Hono } from 'hono';

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

import {
  EmbeddedAgentStreamEventSchema,
  type EmbeddedAgentStreamEvent,
} from '@agent-console/shared';

/** Small enough that one scripted reading crosses it; the ratio is what matters, not the scale. */
const CONTEXT_WINDOW_TOKENS = 1000;
/** 900/1000 = 0.9 >= the 0.85 default. The loop computes this itself. */
const OVER_THRESHOLD_PROMPT_TOKENS = 900;

const FIRST_USER_TEXT = 'first message, which fills the window';
const FIRST_ANSWER = 'first answer';
const DISTILLATION = 'DISTILLED-SUMMARY-OF-THE-CONVERSATION';
const SECOND_USER_TEXT = 'second message, after the compaction';
const SECOND_ANSWER = 'second answer';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ChatCompletionRequestBody {
  messages?: Array<{ role?: string; content?: string }>;
}

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A complete SSE turn: one text delta, then a `usage`-bearing final chunk. */
function textTurnSse(text: string, promptTokens: number): string {
  return (
    sseEvent({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    // OpenAI sends usage on a final chunk with an EMPTY choices array; the
    // adapter must read it before its own `choices[0]` guard. Scripting it
    // that way keeps this E2E honest about the real wire shape.
    sseEvent({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } }) +
    'data: [DONE]\n\n'
  );
}

describe('E2E: Compaction shipping path (single-user, openai-api engine)', () => {
  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;

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
    'crosses the threshold on a real usage reading, emits the boundary marker onto the persisted stream, and continues the same conversation',
    async () => {
      // --- Fixture: a scripted provider that answers by turn ordinal ---
      // Turn 1: an over-threshold usage reading, which is what makes the loop
      // decide to compact. Turn 2: the distillation request the loop makes on
      // its own (recognised by the compaction prompt reaching the provider as
      // the last user message). Turn 3: the follow-up user turn.
      const providerRequests: ChatCompletionRequestBody[] = [];
      stubServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const body = (await req.json()) as ChatCompletionRequestBody;
            providerRequests.push(body);
            const messages = body.messages ?? [];
            const lastUser = [...messages].reverse().find((m) => m.role === 'user');
            const isDistillationRequest = (lastUser?.content ?? '').includes(
              'approaching its context window limit',
            );
            if (isDistillationRequest) {
              // The distillation call's own usage reflects the pre-compaction
              // prompt size, which is what the marker reports as `preTokens`.
              return new Response(textTurnSse(DISTILLATION, OVER_THRESHOLD_PROMPT_TOKENS), {
                headers: { 'Content-Type': 'text/event-stream' },
              });
            }
            const isSecondUserTurn = (lastUser?.content ?? '').includes(SECOND_USER_TEXT);
            return new Response(
              isSecondUserTurn
                ? // Comfortably under the threshold, so the follow-up turn does
                  // not itself trigger a second compaction -- which would make
                  // "the conversation continued" ambiguous.
                  textTurnSse(SECOND_ANSWER, 10)
                : textTurnSse(FIRST_ANSWER, OVER_THRESHOLD_PROMPT_TOKENS),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      let mcpBaseUrl = '';
      ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
      const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner', '/home/owner');

      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', ctx!);
        await next();
      });
      app.route('/api', api);
      // The loop connects its MCP client at activation and treats a failure
      // as fatal, so the REAL /mcp app has to be mounted even though this
      // test exercises no MCP tool of its own.
      const mcpApp = createMcpApp({
        sessionManager: ctx.sessionManager,
        repositoryManager: ctx.repositoryManager,
        agentManager: ctx.agentManager,
        agentDirectory: ctx.agentDirectory,
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
        artifactRepository: ctx.artifactRepository,
        bookmarkRepository: ctx.bookmarkRepository,
        broadcastToApp: ctx.broadcastToApp,
        fetchPullRequestUrl: ctx.fetchPullRequestUrl,
        findOpenPullRequest: ctx.findOpenPullRequest,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
      });
      app.route('', mcpApp);

      appServer = Bun.serve({ fetch: app.fetch, port: 0 });
      mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

      realCwd = path.join(os.tmpdir(), `ac-compaction-e2e-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      // --- Create the definition through the REAL REST route, carrying the
      // window that makes the threshold computable at all ---
      const createRes = await app.fetch(
        new Request('http://localhost/api/embedded-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Stub local LLM (compaction)',
            provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'stub-model' },
            contextWindowTokens: CONTEXT_WINDOW_TOKENS,
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
      const workerId = worker!.id;

      // The toggle defaults ON, which is what makes this the DEFAULT shipping
      // path rather than an opted-into one.
      expect(worker!.type).toBe('embedded-agent');
      if (worker!.type === 'embedded-agent') expect(worker!.autoCompaction).toBe(true);

      await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, workerId);

      const readEvents = async (): Promise<{
        events: EmbeddedAgentStreamEvent[];
        parseFailures: string[];
      }> => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(session.id, workerId);
        const events: EmbeddedAgentStreamEvent[] = [];
        const parseFailures: string[] = [];
        if (hist) {
          for (const line of hist.data.split('\n')) {
            if (line.trim() === '') continue;
            let json: unknown;
            try {
              json = JSON.parse(line);
            } catch {
              parseFailures.push(line);
              continue;
            }
            const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, json);
            if (parsed.success) events.push(parsed.output);
            else parseFailures.push(line);
          }
        }
        return { events, parseFailures };
      };

      const waitFor = async (
        label: string,
        predicate: (events: EmbeddedAgentStreamEvent[]) => boolean,
      ): Promise<EmbeddedAgentStreamEvent[]> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const { events } = await readEvents();
          const fatal = events.find((e) => e.type === 'fatal');
          if (fatal && fatal.type === 'fatal') {
            throw new Error(`loop emitted a fatal event while waiting for ${label}: ${fatal.message}`);
          }
          if (predicate(events)) return events;
          await delay(200);
        }
        const { events } = await readEvents();
        throw new Error(
          `timed out waiting for ${label}. Observed types: ${JSON.stringify(events.map((e) => e.type))}`,
        );
      };

      // --- Turn 1: the loop's own threshold decision ---
      const firstSend = await ctx.sessionManager.sendEmbeddedAgentUserMessage(
        session.id,
        workerId,
        FIRST_USER_TEXT,
      );
      expect(firstSend.ok).toBe(true);

      const afterCompaction = await waitFor(
        'the compaction boundary marker',
        (events) => events.some((e) => e.type === 'context-compacted'),
      );

      const marker = afterCompaction.find((e) => e.type === 'context-compacted');
      expect(marker).toBeDefined();
      if (marker && marker.type === 'context-compacted') {
        // Nothing asked for this compaction: `source: 'auto'` is the loop
        // reporting that IT decided, from a usage reading it computed itself.
        expect(marker.source).toBe('auto');
        expect(marker.summary).toBe(DISTILLATION);
        // The severity figures the transcript row renders.
        expect(marker.preTokens).toBe(OVER_THRESHOLD_PROMPT_TOKENS);
        expect(typeof marker.postTokens).toBe('number');
        expect(marker.postTokens!).toBeLessThan(OVER_THRESHOLD_PROMPT_TOKENS);
      }

      // The marker landed AFTER the turn it followed, not in place of it: the
      // turn's own answer is still in the transcript.
      expect(
        afterCompaction.some((e) => e.type === 'assistant-message' && e.text.includes(FIRST_ANSWER)),
      ).toBe(true);

      // --- Turn 2: the conversation continues, on the SAME worker ---
      // This is the property that distinguishes compaction from handoff. No
      // reactivation, no new session -- the next message just works.
      const secondSend = await ctx.sessionManager.sendEmbeddedAgentUserMessage(
        session.id,
        workerId,
        SECOND_USER_TEXT,
      );
      expect(secondSend.ok).toBe(true);

      const final = await waitFor('the follow-up turn to answer', (events) =>
        events.some((e) => e.type === 'assistant-message' && e.text.includes(SECOND_ANSWER)),
      );

      // Every persisted line parses through the client's own schema -- the
      // marker included. A wire-layer gate that dropped or mangled it would
      // surface here, not only as a missing UI row.
      const { parseFailures } = await readEvents();
      expect(parseFailures).toEqual([]);
      expect(
        final.some((e) => e.type === 'assistant-message' && e.text.includes(SECOND_ANSWER)),
      ).toBe(true);

      // --- The conversation actually became shorter, as the provider saw it ---
      // The follow-up request's message array is the ground truth for
      // "compacted", and it is only visible from the provider's side.
      const followUpRequest = providerRequests.find((body) =>
        (body.messages ?? []).some((m) => m.role === 'user' && (m.content ?? '').includes(SECOND_USER_TEXT)),
      );
      expect(followUpRequest).toBeDefined();
      const followUpMessages = followUpRequest!.messages ?? [];
      // The summary replaced the head of the conversation...
      expect(followUpMessages.some((m) => (m.content ?? '').includes(DISTILLATION))).toBe(true);
      // ...and the original exchange is gone from what the model now sees,
      // which is the whole point of having compacted.
      expect(followUpMessages.some((m) => (m.content ?? '').includes(FIRST_USER_TEXT))).toBe(false);
      expect(followUpMessages.some((m) => (m.content ?? '').includes(FIRST_ANSWER))).toBe(false);

      // --- Deactivate cleanly ---
      await ctx.sessionManager.deactivateEmbeddedAgentWorker(session.id, workerId);
    },
    60_000,
  );
});
