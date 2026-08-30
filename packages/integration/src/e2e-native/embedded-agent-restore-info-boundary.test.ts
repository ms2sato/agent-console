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
 * Also covers the `completed` field (Issue #1205) added to `restore-info`:
 * a real second-activation restore cycle must observe `completed: false`
 * immediately after `activateEmbeddedAgentWorker()` resolves (the new
 * incarnation's loop subprocess has not yet reported `ready`), then
 * `completed: true` once the real subprocess's `ready` event has actually
 * been observed server-side -- exercising the exact server-authoritative
 * signal the client's `restoring` derivation now depends on entirely, over
 * a real subprocess rather than a simulated WS frame.
 *
 * #1447 stage 4 (R1/R2/R4): the genuine-failure test below now exercises the
 * PRIMARY preserve-and-declare path over a real subprocess and real storage
 * -- the corrupted file is no longer reset, a `restore-failure-boundary`
 * marker is appended in place, and the pre-corruption rows remain readable
 * through the ordinary history read. A third test drives a SECOND restart
 * after that failure, with a tool-using turn in the post-marker
 * conversation (test-trigger.md's "the conversation must use a tool" rule),
 * and asserts reconstruction SUCCEEDS this time -- R2's guarantee that a
 * restore failure is a one-time loss, not a permanent loop.
 *
 * Spec: docs/design/embedded-agent-worker.md "Transcript Restore" § UI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
// #1449's genuine-failure test reads/writes the PERSISTED live output file
// directly. That file lives under `AGENT_CONSOLE_HOME` (`/test/config` in
// this harness), a path `setupTestEnvironment` backs with memfs -- `fs
// /promises` is `mock.module`d to route there (see
// `@agent-console/server/src/__tests__/utils/mock-fs-helper.ts`), while
// `Bun.file()`/`Bun.write()` are native Bun APIs that bypass that mock
// entirely and hit the REAL filesystem, producing an ENOENT for a path that
// only exists in the virtual one. `fs/promises` is therefore required here,
// not a style choice -- confirmed by hitting exactly that ENOENT first.
import * as fs from 'node:fs/promises';
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

/**
 * #1449 widened `RestoreInfo` / `RestoreInfoMessageSchema` to a two-branch
 * union (success / failure). This whole test drives a SUCCESSFUL restore
 * cycle, so every value read here is asserted into the success branch --
 * an assertion, not a cast, so a real restore that unexpectedly failed
 * fails loudly here rather than silently widening every `.completed` /
 * `.restoredMessageCount` access below.
 */
function assertRestoreSuccess<T extends { failed?: boolean }>(info: T | null | undefined): Exclude<T, { failed: true }> {
  if (info == null) throw new Error('expected a non-null restore-info value');
  if (info.failed === true) throw new Error('expected the restore-info SUCCESS form, got the #1449 failure form');
  return info as Exclude<T, { failed: true }>;
}

describe('Client-Server Boundary: restore-info WorkerServerMessage (Transcript Restore #1123)', () => {
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
    'a real restore cycle produces a getRestoreInfo() value that parses via RestoreInfoMessageSchema, for BOTH the triggering connection and a re-delivery lookup, and completed flips false -> true once the real subprocess reports ready (#1205)',
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

      // A successful restore does NOT truncate the persisted log (4e), so the
      // FIRST activation's `ready` event is still present in the full
      // history once the second activation runs -- waiting for "any `ready`
      // event" would false-positive on that stale row immediately. This
      // must wait for a NEW `ready` beyond whatever count was already
      // present, exactly the incarnation-vs-epoch distinction Issue #1205 is
      // about (see `readyCountBefore` at the call site).
      const waitForReadyCountAbove = async (minCount: number, deadlineMs: number): Promise<void> => {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const events = await readEvents();
          if (events.filter((e) => e.type === 'ready').length > minCount) return;
          await delay(200);
        }
        throw new Error('Timed out waiting for a new ready event');
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
      const readyCountBefore = (await readEvents()).filter((e) => e.type === 'ready').length;
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

      // Issue #1205: immediately after activation resolves, the new
      // incarnation's loop subprocess has not yet had a chance to report
      // `ready` over stdout (that is a genuinely later, async stdout event) --
      // `completed` must be `false` at this point over a REAL subprocess, not
      // just in the store's simulated-WS unit tests.
      const infoBeforeReady = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoBeforeReady).not.toBeNull();
      expect(assertRestoreSuccess(infoBeforeReady).completed).toBe(false);

      const info = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(info).not.toBeNull();

      // The exact wire payload shape routes.ts builds: `{ type: 'restore-info', ...info }`.
      const wirePayload = JSON.parse(JSON.stringify({ type: 'restore-info', ...info }));
      const parsedResult = v.safeParse(RestoreInfoMessageSchema, wirePayload);
      expect(parsedResult.success).toBe(true);
      if (!parsedResult.success) {
        throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsedResult.issues.map((i) => i.message))}`);
      }
      const parsed = assertRestoreSuccess(parsedResult.output);
      // The value the client turns into "Loading N previous messages..." and
      // into the `> 0` gate on its "may not have carried over" notice. Pinned
      // to the EXACT number the transcript justifies rather than `> 0`: the
      // first incarnation said one thing and received one reply, so exactly
      // two entries originate from the persisted transcript. The system
      // prompt is reassembled fresh on this activation and is not restored
      // content -- counting it (the behaviour this replaces) reports 3 here,
      // and floors the count at 1 for a worker that was never spoken to.
      const conversationalRows = (await readEvents()).filter(
        (e) => e.type === 'user-message' || e.type === 'assistant-message',
      );
      // Independent oracle read off the real persisted log, so the pin below
      // is not just this test agreeing with itself.
      expect(conversationalRows.length).toBe(2);
      expect(parsed.restoredMessageCount).toBe(2);
      expect(parsed.repairedToolCallIds).toEqual([]);
      expect(typeof parsed.epoch).toBe('number');
      expect(parsed.completed).toBe(false);
      // R1: `sdkResumed` must be ABSENT for this engine, verified on the real
      // wire payload rather than on the service's in-memory object. Absence is
      // a load-bearing wire state -- the client reads `=== false`, so a field
      // that leaked in as `false` here would put a permanent divergence notice
      // on every `openai-api` worker.
      expect('sdkResumed' in wirePayload).toBe(false);
      expect('sdkResumed' in parsed).toBe(false);

      // --- Bootstrap re-delivery equivalent: a SECOND lookup (as a second WS
      // connection's onOpen would perform) returns the SAME restorable shape,
      // also schema-valid. ---
      const infoAgain = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAgain).not.toBeNull();
      const wirePayloadAgain = JSON.parse(JSON.stringify({ type: 'restore-info', ...infoAgain }));
      const parsedAgainResult = v.safeParse(RestoreInfoMessageSchema, wirePayloadAgain);
      expect(parsedAgainResult.success).toBe(true);
      if (parsedAgainResult.success) {
        const parsedAgain = assertRestoreSuccess(parsedAgainResult.output);
        expect(parsedAgain.restoredMessageCount).toBe(parsed.restoredMessageCount);
        expect(parsedAgain.epoch).toBe(parsed.epoch);
        expect(parsedAgain.completed).toBe(false);
      }

      // Issue #1205: once the new incarnation's loop subprocess actually
      // reports `ready` (a real stdout event from a real subprocess), the
      // server must flip `completed` to `true` and this must be visible via
      // BOTH the fast-path-equivalent lookup and a fresh bootstrap-equivalent
      // lookup -- the exact server-authoritative signal the client's
      // `restoring` derivation depends on entirely (Issue #1205).
      await waitForReadyCountAbove(readyCountBefore, 30_000);

      const infoAfterReady = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAfterReady).not.toBeNull();
      const infoAfterReadySuccess = assertRestoreSuccess(infoAfterReady);
      expect(infoAfterReadySuccess.completed).toBe(true);
      expect(infoAfterReadySuccess.epoch).toBe(parsed.epoch);
      const wirePayloadReady = JSON.parse(JSON.stringify({ type: 'restore-info', ...infoAfterReady }));
      const parsedReady = v.safeParse(RestoreInfoMessageSchema, wirePayloadReady);
      expect(parsedReady.success).toBe(true);
      if (parsedReady.success) {
        expect(assertRestoreSuccess(parsedReady.output).completed).toBe(true);
      }
    },
    60_000,
  );

  it(
    '#1449: a GENUINE restore failure over a real subprocess produces a getRestoreInfo() value that parses via RestoreInfoMessageSchema as the failure form',
    async () => {
      // Forces a real `reconstructConversation` throw by corrupting the
      // PERSISTED LIVE OUTPUT FILE on disk between the first deactivate and
      // the second activate -- a malformed trailing line appended AFTER a
      // real, valid line, matching the unit-level `RESTORE_FAILING_STREAM`
      // fixture's shape (a malformed JSON line), not any particular
      // event-ordering shape. Per explicit coordinator guidance: PR #1462
      // (in flight, branch fix/1457-reader-tolerates-either-order) is
      // fixing `restore.ts`'s `replayWindow` so a turn opening with a
      // tool-call reconstructs successfully instead of throwing -- so a
      // failure fixture built on THAT shape would silently stop failing
      // once that PR lands. Malformed JSON bytes are a genuine corruption
      // signal `replayWindow` rejects unconditionally (see its "the tail
      // deliberately stays strict" comment), independent of any event
      // ordering.
      //
      // MUTATION MEASURED (polarity): commenting out `runActivation`'s
      // catch-block `restoreInfo = {failed: true, ...}` assignment (leaving
      // everything else, including this test's file corruption, intact)
      // makes this test fail at `expect(info).not.toBeNull()` with
      // `Received: null` -- the restore genuinely fails (confirmed by the
      // corruption reaching the real `reconstructConversation` call), the
      // failure is just never DECLARED without the fix. Restoring the
      // assignment returns this test to green. This is the shipping-path
      // E2E confirmation that the fix (not merely the fixture) is what this
      // test exercises.
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

      realCwd = path.join(os.tmpdir(), `ac-embedded-restore-failure-boundary-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      const createRes = await app.fetch(
        new Request('http://localhost/api/embedded-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Stub local LLM (restore FAILURE boundary)',
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

      // --- Corrupt the REAL persisted live output file on disk: append a
      // malformed line AFTER the real, valid content. Resolved through the
      // same path resolver `EmbeddedAgentWorkerService` itself uses
      // (`SessionManager.getPathResolverForSessionId`, exposed for exactly
      // this kind of direct-file-access test), so this is not a
      // hand-guessed path. ---
      const resolver = ctx.sessionManager.getPathResolverForSessionId(sessionId);
      expect(resolver).not.toBeNull();
      const liveOutputPath = resolver!.getOutputFilePath(sessionId, workerId);
      const beforeCorruption = await fs.readFile(liveOutputPath, 'utf-8');
      expect(beforeCorruption.trim().length).toBeGreaterThan(0);
      // Not the FIRST line of the file (the file was never rotated, so
      // `allowLeadingFragment` is false and the corruption would throw
      // regardless of position -- but appending strictly guarantees the
      // corruption is genuinely mid-stream, not merely a first-line
      // fragment that a future change to leading-fragment tolerance could
      // legitimately start absorbing).
      await fs.writeFile(
        liveOutputPath,
        `${beforeCorruption}${JSON.stringify({ v: 1, type: 'user-message', id: 'corrupt' })}\n{not valid json`,
        'utf-8',
      );

      // #1447 stage 4 (R1/R3): the epoch BEFORE the failed restore, so the
      // primary preserve-and-declare path's "no epoch bump" guarantee is
      // checked against a captured value rather than `expect.any(Number)`.
      const histBeforeSecondActivation = await ctx.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      expect(histBeforeSecondActivation).not.toBeNull();
      const epochBeforeSecondActivation = histBeforeSecondActivation!.epoch;

      // --- Second activation: restore fires for real, and now fails for
      // real -- but #1447 stage 4 makes preserve-and-declare the PRIMARY
      // path, not a reset. The real `appendRestoreFailureMarker` write is
      // unmocked here, so this exercises the shipping path end to end. ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

      const info = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(info).not.toBeNull();
      // R3: no epoch bump on the primary path -- unchanged from before.
      // R4: preservation is 'in-band' (the marker append succeeded).
      expect(info).toEqual({ epoch: epochBeforeSecondActivation, failed: true, preservation: 'in-band' });
      // openai-api engine (this harness's stub provider): the failure form
      // must OMIT sdkResumed entirely, not carry it as false/undefined.
      expect('sdkResumed' in (info as object)).toBe(false);

      // C1/R1: the pre-corruption rows are STILL SERVED by the ordinary
      // history read -- nothing was reset or deleted. And R2's marker is
      // present in the SAME live stream, not hidden in an invisible sidecar.
      const eventsAfterFailure = await readEvents();
      expect(eventsAfterFailure.some((e) => e.type === 'user-message' && e.text === USER_TEXT)).toBe(true);
      expect(eventsAfterFailure.some((e) => e.type === 'assistant-message' && e.text === REPLY_TEXT)).toBe(true);
      expect(eventsAfterFailure.some((e) => e.type === 'restore-failure-boundary')).toBe(true);
      // And no `<workerId>.restore-failed.log` sidecar was created -- the
      // fallback path never ran.
      const sidecarPath = `${liveOutputPath.replace(/\.log$/, '')}.restore-failed.log`;
      expect(await fs.stat(sidecarPath).then(() => true, () => false)).toBe(false);

      // The exact wire payload shape routes.ts builds: `{ type: 'restore-info', ...info }`.
      const wirePayload = JSON.parse(JSON.stringify({ type: 'restore-info', ...info }));
      const parsedResult = v.safeParse(RestoreInfoMessageSchema, wirePayload);
      expect(parsedResult.success).toBe(true);
      if (!parsedResult.success) {
        throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsedResult.issues.map((i) => i.message))}`);
      }
      expect(parsedResult.output).toEqual({
        type: 'restore-info',
        epoch: wirePayload.epoch,
        failed: true,
        preservation: 'in-band',
      });
      expect('sdkResumed' in parsedResult.output).toBe(false);

      // --- Bootstrap re-delivery equivalent (as a second WS connection's
      // onOpen would perform) returns the SAME failure shape, also
      // schema-valid -- the failure form must survive bootstrap re-delivery
      // exactly like the success form does. ---
      const infoAgain = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAgain).toEqual({ epoch: wirePayload.epoch, failed: true, preservation: 'in-band' });
      const wirePayloadAgain = JSON.parse(JSON.stringify({ type: 'restore-info', ...infoAgain }));
      const parsedAgainResult = v.safeParse(RestoreInfoMessageSchema, wirePayloadAgain);
      expect(parsedAgainResult.success).toBe(true);
      if (parsedAgainResult.success) {
        expect(parsedAgainResult.output).toEqual({
          type: 'restore-info',
          epoch: wirePayload.epoch,
          failed: true,
          preservation: 'in-band',
        });
      }

      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);
    },
    60_000,
  );

  it(
    '#1447 stage 4 (R2): the SECOND restart after a failed restore reconstructs SUCCESSFULLY from the marker boundary, over a real subprocess and a real tool-using turn',
    async () => {
      // Reuses the exact corruption technique from the GENUINE-failure test
      // above to reach the primary-path marker, then drives a THIRD
      // activation whose conversation includes a real builtin `Read` tool
      // call (test-trigger.md's "the conversation must use a tool" rule),
      // then a FOURTH activation to confirm THAT restores successfully --
      // this is R2's guarantee under test: the marker turns a corrupt
      // region into a one-time loss, not a permanent restore-failure loop.
      //
      // No recall assertion is used here (the stub's answers are scripted,
      // not a model recalling a planted fact), so testing.md's
      // negative-control requirement for a recall assertion does not apply
      // -- same "not applicable" shape as
      // embedded-agent-restore-rotation-boundary.test.ts's C7 clause 2.
      const NOTE_TEXT = 'hello from the stage-4 restart e2e';
      const READ_TRIGGER_TEXT = 'please read the notes file';
      const READ_ACK_TEXT = 'Checking the notes file.';
      const FINAL_ANSWER_TEXT = 'The notes file says hello.';

      function sse(obj: unknown): string {
        return `data: ${JSON.stringify(obj)}\n\n`;
      }
      function readToolCallSse(): string {
        return (
          sse({ choices: [{ delta: { content: READ_ACK_TEXT }, finish_reason: null }] }) +
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-restart-read',
                      function: { name: 'Read', arguments: JSON.stringify({ path: 'notes.txt' }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }) +
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
          'data: [DONE]\n\n'
        );
      }
      function finalAfterToolSse(): string {
        return (
          sse({ choices: [{ delta: { content: FINAL_ANSWER_TEXT }, finish_reason: null }] }) +
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n'
        );
      }

      interface ChatBody {
        messages?: Array<{ role?: string; content?: string }>;
      }

      stubServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const body = (await req.json()) as ChatBody;
            const hasToolMsg = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
            if (hasToolMsg) {
              return new Response(finalAfterToolSse(), { headers: { 'Content-Type': 'text/event-stream' } });
            }
            const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
            if (lastUser?.content === USER_TEXT) {
              return new Response(plainTextSse(), { headers: { 'Content-Type': 'text/event-stream' } });
            }
            return new Response(readToolCallSse(), { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      let mcpBaseUrl = '';
      ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
      const owner = await ctx.userRepository.upsertByOsUid(54326, 'owner6', '/home/owner6');

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

      realCwd = path.join(os.tmpdir(), `ac-embedded-restore-second-restart-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);
      // Real file for the builtin Read tool call, same technique as
      // embedded-agent-e2e.test.ts: `Bun.write` is native and bypasses this
      // test process's memfs mock, landing on the REAL filesystem the loop
      // subprocess reads from.
      await Bun.write(path.join(realCwd, 'notes.txt'), NOTE_TEXT);

      const createRes = await app.fetch(
        new Request('http://localhost/api/embedded-agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Stub local LLM (restore SECOND RESTART boundary)',
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

      // Scoped to events AT OR AFTER `sinceIndex` -- an unscoped scan across
      // the whole cumulative history would be satisfied by an EARLIER
      // activation's already-completed turn (test-trigger.md's absence/
      // presence-scoping rule), which is exactly the trap here: activation 1
      // already has an assistant-message followed by state:idle, so an
      // unscoped check would return immediately without ever observing
      // activation 2's own (later) turn complete.
      const waitForIdleAfterAssistant = async (deadlineMs: number, sinceIndex: number): Promise<void> => {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const events = (await readEvents()).slice(sinceIndex);
          const fatal = events.find((e) => e.type === 'fatal');
          if (fatal && fatal.type === 'fatal') throw new Error(`loop emitted fatal: ${fatal.message}`);
          const turnErr = events.find((e) => e.type === 'turn-error');
          if (turnErr && turnErr.type === 'turn-error') throw new Error(`loop emitted turn-error: ${turnErr.message}`);
          if (hasIdleAfterAssistant(events)) return;
          await delay(200);
        }
        throw new Error('Timed out waiting for idle-after-assistant');
      };

      // --- Activation 1: establish an initial transcript, then deactivate. ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
      const sendRes1 = await ctx.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, USER_TEXT);
      expect(sendRes1.ok).toBe(true);
      await waitForIdleAfterAssistant(30_000, 0);
      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);

      // --- Corrupt the live output file, same technique as the GENUINE
      // failure test above. ---
      const resolver = ctx.sessionManager.getPathResolverForSessionId(sessionId);
      expect(resolver).not.toBeNull();
      const liveOutputPath = resolver!.getOutputFilePath(sessionId, workerId);
      const beforeCorruption = await fs.readFile(liveOutputPath, 'utf-8');
      await fs.writeFile(
        liveOutputPath,
        `${beforeCorruption}${JSON.stringify({ v: 1, type: 'user-message', id: 'corrupt' })}\n{not valid json`,
        'utf-8',
      );

      // --- Activation 2: restore fails, primary path appends the marker
      // in place (verified by the GENUINE-failure test above; only the
      // failure form is checked here, as the setup step for what follows). ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
      const infoAfterFailure = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAfterFailure).toEqual({
        epoch: expect.any(Number),
        failed: true,
        preservation: 'in-band',
      });

      // --- Activation 2's OWN conversation is the post-marker window: a
      // real tool-using turn (builtin Read), so the window this second
      // restart must reconstruct from is not merely a bare marker. ---
      const eventCountBeforeReadTurn = (await readEvents()).length;
      const sendRes2 = await ctx.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, READ_TRIGGER_TEXT);
      expect(sendRes2.ok).toBe(true);
      await waitForIdleAfterAssistant(30_000, eventCountBeforeReadTurn);

      const eventsAfterReadTurn = await readEvents();
      const readToolCall = eventsAfterReadTurn.find((e) => e.type === 'tool-call' && e.name === 'Read');
      expect(readToolCall).toBeDefined();
      const readToolResult = eventsAfterReadTurn.find(
        (e) => e.type === 'tool-result' && readToolCall?.type === 'tool-call' && e.callId === readToolCall.callId,
      );
      expect(readToolResult).toBeDefined();
      if (readToolResult?.type === 'tool-result') {
        expect(readToolResult.result).toContain(NOTE_TEXT);
      }

      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);

      // --- Activation 3: THE SECOND RESTART after the failed restore.
      // Reconstruction must SUCCEED this time -- R2's guarantee. ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
      const infoAfterSecondRestart = ctx.sessionManager.getEmbeddedAgentRestoreInfo(sessionId, workerId);
      expect(infoAfterSecondRestart).not.toBeNull();
      expect(infoAfterSecondRestart?.failed).not.toBe(true);
      if (infoAfterSecondRestart && infoAfterSecondRestart.failed !== true) {
        // The window opens at the marker (no summary, no pre-corruption
        // content) and replays the tool-using turn: user + assistant(call) +
        // tool + assistant(final) = 4 transcript-originating entries.
        expect(infoAfterSecondRestart.restoredMessageCount).toBe(4);
      }

      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);
    },
    60_000,
  );
});
