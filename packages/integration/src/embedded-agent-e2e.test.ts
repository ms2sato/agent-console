/**
 * E2E (shipping-path) test for the embedded-agent worker (Issue #1011, Phase 2).
 *
 * This exercises the REAL flow end-to-end, with NO mocks of the loop and no
 * PTY-byte-probe shortcuts:
 *
 *   - The loop subprocess (`bun packages/embedded-agent/src/main.ts`) is spawned
 *     for real by `EmbeddedAgentWorkerService` (single-user mode -> `spawnAsUser`
 *     bypasses elevation).
 *   - The loop talks to a REAL `/mcp` endpoint over HTTP, carrying its per-worker
 *     bearer token minted at activation (Issue #878 phase 1). A recording
 *     middleware in front of the real MCP route observes those HTTP requests.
 *   - The loop talks to a scripted stub OpenAI-compatible provider over HTTP.
 *
 * The single test drives: REST create definition -> create session + worker ->
 * activate -> send user message -> poll the replayed NDJSON history -> assert the
 * full structured-event sequence (user-message, state, deltas, tool-call,
 * tool-result, final assistant-message, idle), the real bearer token hitting the
 * real MCP server, the scripted provider round-trip (tool-call turn then final
 * answer with the tool result fed back), the negative secret assertion against
 * /proc, and graceful deactivation (exited code 0, token revoked, activated
 * false).
 *
 * Spec: docs/design/embedded-agent-worker.md Part II § "Testing plan" (E2E
 * bullet) and § "Stdio protocol (v1)".
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
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

import {
  EmbeddedAgentStreamEventSchema,
  type EmbeddedAgentStreamEvent,
} from '@agent-console/shared';

const USER_TEXT = 'list the sessions please';
const CALL1_TEXT = 'Let me check the sessions.';
const FINAL_ANSWER = 'Sessions listed.';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal shape of the chat.completions request bodies the stub records. */
interface ChatCompletionRequestBody {
  model?: string;
  stream?: boolean;
  tools?: Array<{ type?: string; function?: { name?: string } }>;
  messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
}

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * First provider turn (no role:'tool' message present): a text delta, then a
 * tool-call whose id/name land in the first delta and whose `{}` arguments are
 * split across two `data:` events for the same index (exercises accumulation),
 * then finish_reason 'tool_calls', then [DONE].
 */
function toolCallSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: CALL1_TEXT }, finish_reason: null }] }) +
    sseEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'list_sessions', arguments: '{' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseEvent({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: null },
      ],
    }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  );
}

/** Second provider turn (role:'tool' present): a few text deltas + finish 'stop'. */
function finalAnswerSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: 'Sessions ' }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: { content: 'listed.' }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

interface OrderStep {
  label: string;
  match: (e: EmbeddedAgentStreamEvent) => boolean;
}

/** Assert every step matches in sequence (each after the previous match's index). */
function assertInOrder(events: EmbeddedAgentStreamEvent[], steps: OrderStep[]): void {
  let cursor = 0;
  for (const step of steps) {
    let found = -1;
    for (let j = cursor; j < events.length; j++) {
      if (step.match(events[j])) {
        found = j;
        break;
      }
    }
    if (found === -1) {
      throw new Error(
        `E2E event sequence: could not find "${step.label}" at or after index ${cursor}. ` +
          `Observed types: ${JSON.stringify(events.map((e) => e.type))}`,
      );
    }
    cursor = found + 1;
  }
}

function hasIdleAfterAssistant(events: EmbeddedAgentStreamEvent[]): boolean {
  let sawAssistant = false;
  for (const e of events) {
    if (e.type === 'assistant-message') sawAssistant = true;
    if (sawAssistant && e.type === 'state' && e.state === 'idle') return true;
  }
  return false;
}

describe('E2E: EmbeddedAgentWorker shipping path (single-user)', () => {
  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;

  // The shared setup.ts preload registers happy-dom globals for React/DOM
  // boundary tests. happy-dom replaces the global `Response` / `Headers`
  // implementations, which makes `Bun.serve` serialize this test's real HTTP
  // responses as `text/plain` — the loop subprocess's MCP client then rejects
  // them ("Unexpected content type"). This E2E needs no DOM, so unregister
  // happy-dom for its duration and restore it afterward for later files.
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
    // Deactivate any live embedded-agent subprocess so nothing is orphaned when
    // a test fails before its own deactivation step.
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
    'drives create -> activate -> user-message -> tool-call -> final answer -> deactivate through the real loop, MCP, and provider',
    async () => {
      // --- Fixture 1: scripted stub OpenAI-compatible provider ---
      const providerRequests: ChatCompletionRequestBody[] = [];
      stubServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const body = (await req.json()) as ChatCompletionRequestBody;
            providerRequests.push(body);
            const hasToolMsg =
              Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
            const sse = hasToolMsg ? finalAnswerSse() : toolCallSse();
            return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      // --- Test AppContext, with the loop's MCP base URL late-bound to the app port ---
      let mcpBaseUrl = '';
      ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

      // Seed a user; the session's createdBy (and therefore the minted MCP
      // caller identity) references this record.
      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

      // --- Fixture 2: real app server (real /api router + real /mcp app) ---
      const capturedMcpAuth: string[] = [];
      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', ctx!);
        await next();
      });
      // Record the Authorization header of every REAL HTTP request to /mcp
      // (shipping path intact — this observes, does not intercept).
      app.use('*', async (c, next) => {
        if (c.req.path === '/mcp') {
          const auth = c.req.header('authorization');
          if (auth) capturedMcpAuth.push(auth);
        }
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

      // The subprocess cwd must exist on the REAL filesystem. Server-side fs is
      // memfs-mocked, so create the dir via a real spawn rather than node fs.
      realCwd = path.join(os.tmpdir(), `ac-embedded-e2e-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      // --- Step 2: create the embedded-agent definition through the REAL REST route ---
      // Drive it in-process via `app.fetch` (identical middleware + handler
      // chain to the served port) rather than the global `fetch`: the
      // happy-dom preload (setup.ts) replaces this process's global `fetch`
      // with a window HTTP client that cannot parse the Bun/Hono response. The
      // real port is still served for the loop subprocess's MCP HTTP calls,
      // which use real Bun fetch in a separate process, unaffected by happy-dom.
      const createRes = await app.fetch(
        new Request('http://localhost/api/embedded-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Stub local LLM',
            provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'stub-model' },
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { embeddedAgent: { id: string } };
      const embeddedAgentId = createBody.embeddedAgent.id;
      expect(embeddedAgentId).toBeTruthy();

      // --- Step 3: create a quick session owned by the seeded user ---
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const sessionId = session.id;

      // --- Step 4: add an embedded-agent worker ---
      const worker = await ctx.sessionManager.createWorker(sessionId, {
        type: 'embedded-agent',
        embeddedAgentId,
      });
      expect(worker).not.toBeNull();
      const workerId = worker!.id;

      // --- Step 5: activate (spawn loop, init handshake, start streaming) ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

      // --- Step 6: send a user message ---
      const sendRes = await ctx.sessionManager.sendEmbeddedAgentUserMessage(
        sessionId,
        workerId,
        USER_TEXT,
      );
      expect(sendRes.ok).toBe(true);

      // --- Step 7: poll the replayed NDJSON history until the turn completes ---
      const readEvents = async (): Promise<{
        events: EmbeddedAgentStreamEvent[];
        parseFailures: string[];
      }> => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
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

      const deadline = Date.now() + 30_000;
      let events: EmbeddedAgentStreamEvent[] = [];
      while (Date.now() < deadline) {
        const res = await readEvents();
        events = res.events;
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal && fatal.type === 'fatal') {
          throw new Error(`loop emitted a fatal event: ${fatal.message}`);
        }
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr && turnErr.type === 'turn-error') {
          throw new Error(`loop emitted a turn-error event: ${turnErr.message}`);
        }
        if (hasIdleAfterAssistant(events)) break;
        await delay(200);
      }

      // Re-read once for the final assertion set; every line MUST parse.
      const final = await readEvents();
      events = final.events;
      expect(final.parseFailures).toEqual([]);
      expect(hasIdleAfterAssistant(events)).toBe(true);

      // --- Assertion: full event sequence, in order ---
      assertInOrder(events, [
        {
          label: 'user-message (server-authored, matching text, before any turn event)',
          match: (e) => e.type === 'user-message' && e.text === USER_TEXT,
        },
        { label: 'state active', match: (e) => e.type === 'state' && e.state === 'active' },
        { label: 'assistant-delta', match: (e) => e.type === 'assistant-delta' },
        {
          label: 'tool-call list_sessions',
          match: (e) => e.type === 'tool-call' && e.name === 'list_sessions',
        },
        { label: 'tool-result ok', match: (e) => e.type === 'tool-result' && e.ok === true },
        {
          label: 'final assistant-message',
          match: (e) => e.type === 'assistant-message' && e.text.includes(FINAL_ANSWER),
        },
        { label: 'state idle', match: (e) => e.type === 'state' && e.state === 'idle' },
      ]);

      // --- Assertion: tool-result carries a non-empty result mentioning the session ---
      const toolResult = events.find((e) => e.type === 'tool-result');
      expect(toolResult).toBeDefined();
      if (toolResult && toolResult.type === 'tool-result') {
        expect(toolResult.ok).toBe(true);
        expect(toolResult.result.length).toBeGreaterThan(0);
        expect(toolResult.result).toContain(sessionId);
      }

      // --- Assertion: the REAL bearer token from the init handshake hit /mcp ---
      expect(capturedMcpAuth.length).toBeGreaterThan(0);
      for (const header of capturedMcpAuth) {
        expect(header).toMatch(/^Bearer [0-9a-f]{64}$/);
      }
      const capturedToken = capturedMcpAuth[0].slice('Bearer '.length);
      const identity = ctx.mcpTokenRegistry.verify(capturedToken);
      expect(identity).not.toBeNull();
      expect(identity?.workerId).toBe(workerId);
      expect(identity?.sessionId).toBe(sessionId);
      expect(identity?.userId).toBe(owner.id);

      // --- Assertion: the scripted provider round-trip ---
      expect(providerRequests.length).toBe(2);
      expect(providerRequests[0].stream).toBe(true);
      expect(Array.isArray(providerRequests[0].tools)).toBe(true);
      expect(
        (providerRequests[0].tools ?? []).some((t) => t.function?.name === 'list_sessions'),
      ).toBe(true);
      const secondMessages = providerRequests[1].messages ?? [];
      const toolMessage = secondMessages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content).toBe('string');
      expect((toolMessage?.content ?? '').length).toBeGreaterThan(0);
      expect(toolMessage?.content ?? '').toContain(sessionId);

      // --- Negative secret assertion (while still activated) ---
      // On Linux — the only platform where this repo expects /proc to be usable —
      // this check MUST actually execute. A silently-skipped block (process
      // already exited, unknown pid, /proc unreadable) would report green while
      // never comparing the token against the process cmdline/environ, giving
      // false confidence. `procAssertionRan` converts every such skip into a
      // loud Linux failure; on non-Linux the whole block is skipped gracefully.
      if (process.platform === 'linux') {
        const internalWorker = ctx.sessionManager.getWorker(sessionId, workerId);
        const pid =
          internalWorker && internalWorker.type === 'embedded-agent'
            ? internalWorker.subprocess?.pid
            : undefined;
        // The worker is still activated here, so the subprocess is alive and its
        // pid must be known — a missing pid is a real failure, not a skip.
        expect(pid).toBeDefined();

        let procAssertionRan = false;
        if (pid !== undefined) {
          for (const procFile of ['cmdline', 'environ']) {
            // Bun.file is native and bypasses the server-side memfs mock, so it
            // reads the REAL /proc entry.
            const file = Bun.file(`/proc/${pid}/${procFile}`);
            if (await file.exists()) {
              const content = await file.text().catch(() => null);
              if (content !== null) {
                expect(content.includes(capturedToken)).toBe(false);
                procAssertionRan = true;
              }
            }
          }
        }
        // Fail loudly if neither /proc entry was actually read + compared.
        expect(procAssertionRan).toBe(true);
      }

      // --- Deactivation: graceful shutdown, exited code 0, token revoked ---
      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);

      let exitedEvent: EmbeddedAgentStreamEvent | undefined;
      const exitDeadline = Date.now() + 5_000;
      while (Date.now() < exitDeadline) {
        const res = await readEvents();
        exitedEvent = res.events.find((e) => e.type === 'exited');
        if (exitedEvent) break;
        await delay(100);
      }
      expect(exitedEvent).toBeDefined();
      if (exitedEvent && exitedEvent.type === 'exited') {
        expect(exitedEvent.code).toBe(0);
      }

      // Token revoked on deactivation.
      expect(ctx.mcpTokenRegistry.verify(capturedToken)).toBeNull();

      // Public worker reflects deactivation.
      const afterSession = ctx.sessionManager.getAllSessions().find((s) => s.id === sessionId);
      const publicWorker = afterSession?.workers.find((w) => w.id === workerId);
      expect(publicWorker?.type === 'embedded-agent' && publicWorker.activated).toBe(false);
    },
    60_000,
  );
});
