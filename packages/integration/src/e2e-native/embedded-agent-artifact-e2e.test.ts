/**
 * E2E (shipping-path) test for the `create_html_artifact` MCP tool reached
 * through an embedded-agent worker (Issue #1312, HTML Artifacts Phase 1,
 * "Embedded: must traverse the real merge" AC).
 *
 * This is goal verification of premise P3
 * (docs/design/html-artifacts.md §3.3, §6): embedded agents reach MCP tools
 * through an UNFILTERED `tools/list`, so `create_html_artifact` must be
 * reachable exactly like any other MCP tool through
 * `CompositeToolExecutor.listTools()` / `.callTool()`. A direct HTTP call
 * from an embedded context would prove nothing about that merge; this test
 * drives a REAL embedded-agent subprocess whose scripted LLM turn invokes
 * the tool, then verifies the artifact out-of-band via the repository/file
 * layer (never trusting only the tool's own JSON self-report).
 *
 * Harness cloned from `embedded-agent-e2e.test.ts` (do not modify that
 * file): real loop subprocess (`bun packages/embedded-agent/src/main.ts`)
 * spawned by the production `EmbeddedAgentWorkerService` activation path,
 * a real `/mcp` endpoint (`createMcpApp` mounted on a real Hono app served
 * via `Bun.serve`), and a scripted stub OpenAI-Chat-Completions-compatible
 * HTTP server standing in for the LLM.
 *
 * Spec: docs/design/html-artifacts.md §3.3 (P3), §6 (surfaces), §8
 * ("Per-surface E2E").
 *
 * NOTE: this file runs under a SEPARATE `bun test` invocation (see
 * `../e2e-native/setup-native.ts` and `package.json`'s `test` script) that
 * never registers happy-dom, so it needs no DOM-avoidance mechanism of its
 * own -- see `setup-native.ts` for why this invocation exists.
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
import { readArtifactFile } from '@agent-console/server/src/lib/artifact-storage';

import {
  EmbeddedAgentStreamEventSchema,
  type EmbeddedAgentStreamEvent,
} from '@agent-console/shared';

const USER_TEXT = 'Please publish this HTML snippet as an artifact.';
const CALL1_TEXT = 'Publishing the artifact now.';
const FINAL_ANSWER = 'Artifact published.';
const ARTIFACT_TITLE = 'E2E Artifact Title';
/** Distinctive HTML content the scripted tool call publishes. */
const ARTIFACT_CONTENT = `<html><head><title>${ARTIFACT_TITLE}</title></head><body><p>hello from artifact e2e</p></body></html>`;

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
 * single `create_html_artifact` tool call whose JSON-stringified arguments
 * are delivered in one delta (matches the actual zod param shape read from
 * `mcp-server.ts`: `content`, `title`, `sessionId`), then finish_reason
 * 'tool_calls', then [DONE]. `sessionId` is bound at call time to the real
 * session id created below (the script must know it ahead of time, per the
 * AC).
 */
function toolCallSse(sessionId: string): string {
  return (
    sseEvent({ choices: [{ delta: { content: CALL1_TEXT }, finish_reason: null }] }) +
    sseEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: {
                  name: 'create_html_artifact',
                  arguments: JSON.stringify({
                    content: ARTIFACT_CONTENT,
                    title: ARTIFACT_TITLE,
                    sessionId,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  );
}

/** Second provider turn (role:'tool' present): a few text deltas + finish 'stop'. */
function finalAnswerSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: 'Artifact ' }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: { content: 'published.' }, finish_reason: null }] }) +
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

describe('E2E: create_html_artifact through the embedded-agent shipping path (P3)', () => {
  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;
  /**
   * `lib/artifact-storage.ts` deliberately writes via `Bun.write` / `Bun.file`
   * (native, real filesystem), bypassing this suite's `mock.module('fs/promises')`
   * memfs interception (`setupTestEnvironment()` points `AGENT_CONSOLE_HOME` at
   * the virtual `/test/config`, which does not exist on the real disk). Every
   * OTHER config-dir consumer in this test goes through the mocked `fs/promises`
   * and does not care whether the path is real, so overriding
   * `AGENT_CONSOLE_HOME` to a real tmpdir here is safe for both: memfs-backed
   * writes key off the path string regardless of real existence, and
   * `writeArtifactFile` gets an actual directory to write into (mirrors
   * `lib/__tests__/artifact-storage.test.ts` and `create-html-artifact.test.ts`'s
   * documented same pattern).
   */
  let artifactsRealHome: string | undefined;

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
    if (artifactsRealHome) {
      Bun.spawnSync(['rm', '-rf', artifactsRealHome]);
      artifactsRealHome = undefined;
    }
  });

  it(
    'drives create -> activate -> user-message -> create_html_artifact tool-call -> final answer, and verifies the artifact out-of-band via the repository/file layer',
    async () => {
      // Point AGENT_CONSOLE_HOME at a REAL directory so `writeArtifactFile`'s
      // native `Bun.write` (see the `artifactsRealHome` comment above) has
      // somewhere to actually write. Must happen before any config-dir-based
      // path is resolved.
      artifactsRealHome = path.join(os.tmpdir(), `ac-embedded-artifact-e2e-home-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', artifactsRealHome]);
      process.env.AGENT_CONSOLE_HOME = artifactsRealHome;

      // --- Test AppContext, with the loop's MCP base URL late-bound to the app port ---
      let mcpBaseUrl = '';
      ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

      // Seed a user; the session's createdBy (and therefore the artifact's
      // attribution -- docs/design/html-artifacts.md §5.2) references this record.
      const owner = await ctx.userRepository.upsertByOsUid(65432, 'artifact-owner', '/home/artifact-owner');

      // --- Fixture 2: real app server (real /api router + real /mcp app) ---
      const capturedMcpAuth: string[] = [];
      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', ctx!);
        await next();
      });
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
      realCwd = path.join(os.tmpdir(), `ac-embedded-artifact-e2e-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      // --- Step 2: create a quick session owned by the seeded user ---
      // Created BEFORE the definition/provider stub so the scripted tool-call
      // arguments below can reference the real sessionId (the AC requires
      // the script to know it ahead of time).
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const sessionId = session.id;

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
            const sse = hasToolMsg ? finalAnswerSse() : toolCallSse(sessionId);
            return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      // --- Step 3: create the embedded-agent definition through the REAL REST route ---
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
          label: 'tool-call create_html_artifact',
          match: (e) => e.type === 'tool-call' && e.name === 'create_html_artifact',
        },
        { label: 'tool-result ok', match: (e) => e.type === 'tool-result' && e.ok === true },
        {
          label: 'final assistant-message',
          match: (e) => e.type === 'assistant-message' && e.text.includes(FINAL_ANSWER),
        },
        { label: 'state idle', match: (e) => e.type === 'state' && e.state === 'idle' },
      ]);

      // --- Assertion: the tool-call/result round-tripped through the real
      // merged CompositeToolExecutor.listTools()/callTool() path (Issue #1312
      // / html-artifacts.md premise P3): a single MCP-sourced
      // `create_html_artifact` tool call succeeding through the same real
      // init -> MCP-connect -> listTools -> callTool cycle the precedent
      // (embedded-agent-e2e.test.ts) uses to prove the merge for
      // `list_sessions` + `Read`. Reachability through the merge is exactly
      // what a successful invocation demonstrates. ---
      const toolCall = events.find((e) => e.type === 'tool-call' && e.name === 'create_html_artifact');
      expect(toolCall).toBeDefined();
      const toolResult =
        toolCall && toolCall.type === 'tool-call'
          ? events.find((e) => e.type === 'tool-result' && e.callId === toolCall.callId)
          : undefined;
      expect(toolResult).toBeDefined();
      let reportedArtifactId: string | undefined;
      if (toolResult && toolResult.type === 'tool-result') {
        expect(toolResult.ok).toBe(true);
        expect(toolResult.result.length).toBeGreaterThan(0);
        const parsedResult = JSON.parse(toolResult.result) as { artifactId?: string };
        reportedArtifactId = parsedResult.artifactId;
        expect(reportedArtifactId).toBeTruthy();
      }
      expect(reportedArtifactId).toBeTruthy();

      // --- Assertion: the artifact exists, verified INDEPENDENTLY of the
      // tool's own JSON self-report -- directly via the repository (DB row)
      // and the on-disk file, the same out-of-band pattern V2-terminal's
      // round used for attribution (docs/design/html-artifacts.md §8
      // "Per-surface E2E": "Parity by test, not review"). ---
      const artifactRecord = await ctx.artifactRepository.findById(reportedArtifactId!);
      expect(artifactRecord).not.toBeNull();
      expect(artifactRecord?.title).toBe(ARTIFACT_TITLE);
      // AC pass condition: "attribution is the embedded session's createdBy".
      expect(artifactRecord?.userId).toBe(owner.id);
      expect(artifactRecord?.userId).toBe(session.createdBy);

      const storedContent = await readArtifactFile(artifactRecord!.userId, artifactRecord!.id);
      expect(storedContent).toBe(ARTIFACT_CONTENT);

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

      // --- Assertion: the scripted provider round-trip, and that
      // `create_html_artifact` was present in the SAME merged tools list sent
      // to the provider (proof of `CompositeToolExecutor.listTools()`
      // reachability over the real init -> MCP-connect -> listTools path,
      // not just at the unit-test level). ---
      expect(providerRequests.length).toBe(2);
      expect(providerRequests[0].stream).toBe(true);
      expect(Array.isArray(providerRequests[0].tools)).toBe(true);
      expect(
        (providerRequests[0].tools ?? []).some((t) => t.function?.name === 'create_html_artifact'),
      ).toBe(true);
      const secondMessages = providerRequests[1].messages ?? [];
      const toolMessage = secondMessages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content).toBe('string');
      expect((toolMessage?.content ?? '').length).toBeGreaterThan(0);
      expect(toolMessage?.content ?? '').toContain(reportedArtifactId!);

      // --- Negative secret assertion (while still activated) ---
      // On Linux -- the only platform where this repo expects /proc to be
      // usable -- this check MUST actually execute. `procAssertionRan`
      // converts a silent skip into a loud Linux failure; on non-Linux the
      // whole block is skipped gracefully.
      if (process.platform === 'linux') {
        const internalWorker = ctx.sessionManager.getWorker(sessionId, workerId);
        const pid =
          internalWorker && internalWorker.type === 'embedded-agent'
            ? internalWorker.subprocess?.pid
            : undefined;
        expect(pid).toBeDefined();

        let procAssertionRan = false;
        if (pid !== undefined) {
          for (const procFile of ['cmdline', 'environ']) {
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
