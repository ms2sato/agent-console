/**
 * E2E (shipping-path) test for the interrupted-turn parent notification
 *: when a delegated embedded-agent worker's turn is cut off by
 * a real process death, the delegating PARENT session is told so, instead of
 * being left waiting on a reply that can never come.
 *
 * This exercises the REAL flow end-to-end, with no mocks of the loop and no
 * PTY-byte-probe shortcuts -- modeled closely on
 * `embedded-agent-e2e.test.ts`'s harness (real `AppContext`, real `/api` +
 * `/mcp` on a real port, a scripted stub OpenAI-compatible provider, real
 * `bun packages/embedded-agent/src/main.ts` subprocesses spawned by the real
 * `EmbeddedAgentWorkerService`).
 *
 * Three sessions: P (the delegating parent, worker activated but never sent
 * a message until the notification arrives), C (a child session with
 * `parentSessionId`/`parentWorkerId` pointing at P, sent a message whose
 * provider request the stub holds open forever so the turn is genuinely
 * mid-flight), and D (a second child, same parentage, activated but left
 * IDLE -- the negative control proving an idle worker's death notifies
 * nobody).
 *
 * NOTE: this file runs under a SEPARATE `bun test` invocation (see
 * `../e2e-native/setup-native.ts` and `package.json`'s `test` script) that
 * never registers happy-dom.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
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

const PARENT_MODEL = 'parent-model';
const CHILD_MODEL = 'child-model';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ChatCompletionRequestBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
}

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A quick, no-tool-calls final answer -- what the PARENT model always gets. */
function finalAnswerSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(100);
  }
}

/**
 * The embedded-agent worker's `subprocess.pid` (what `spawnAsUser`'s
 * non-elevated branch returns, `['sh', '-c', command]`) is the SHELL
 * wrapper's pid, not necessarily the real `bun main.ts` engine's pid: on
 * this host, dash forks a child for this invocation shape rather than
 * exec-replacing itself (confirmed empirically via `ps` -- the exec
 * optimization some POSIX shells apply for a single simple last command did
 * not apply here). Killing the shell wrapper with SIGKILL does not reach
 * the real engine the way the AC's "mid-turn kill" scenario needs: the
 * shell's death alone was observed to let the engine's OWN event loop keep
 * running long enough to write a graceful `turn-error`/`idle` pair before
 * disappearing, which defeats "the server observes a mid-turn exit" (the
 * exact thing Site 1 exists for). Descending to the real engine pid and
 * killing THAT directly (same technique as
 * `scripts/smoke/check-fatal-incarnation-replacement.ts`'s "SIGKILL only
 * the grandchild" shape) is what reliably reproduces a death the running
 * turn has no chance to react to -- SIGKILL is unmaskable, so the engine
 * cannot run any of its own cancellation code once it is the direct target.
 */
function findChildPid(parentPid: number): number | undefined {
  const ps = Bun.spawnSync(['ps', '--ppid', String(parentPid), '-o', 'pid', '--no-headers']);
  const firstLine = ps.stdout.toString().trim().split('\n')[0]?.trim();
  const pid = firstLine ? Number(firstLine) : NaN;
  return Number.isFinite(pid) ? pid : undefined;
}

async function findEnginePid(shellPid: number): Promise<number> {
  await waitFor(() => findChildPid(shellPid) !== undefined, 5_000);
  const pid = findChildPid(shellPid);
  if (pid === undefined) throw new Error(`expected a child process under shell pid ${shellPid}`);
  return pid;
}

describe('E2E: interrupted-turn parent notification', () => {
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
    'a real kill of a delegated child worker mid-turn notifies the delegating parent; an idle child kill notifies nobody; a server-restart revival does not re-notify',
    async () => {
      // --- Fixture 1: scripted stub OpenAI-compatible provider ---
      // PARENT_MODEL requests always get a quick final answer. CHILD_MODEL's
      // FIRST request is held open forever (never resolves), so the child's
      // turn is genuinely mid-flight -- the exact shape the real G1 "mid-turn
      // kill" gate was captured from.
      const requestLog: ChatCompletionRequestBody[] = [];
      let childRequestsSeen = 0;
      stubServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const body = (await req.json()) as ChatCompletionRequestBody;
            requestLog.push(body);
            if (body.model === CHILD_MODEL) {
              childRequestsSeen += 1;
              // Never respond -- the turn hangs mid-flight until the
              // engine process is killed out from under it.
              return new Promise<Response>(() => {});
            }
            return new Response(finalAnswerSse(), { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response('not found', { status: 404 });
        },
      });
      const stubBaseUrl = `http://localhost:${stubServer.port}`;

      // --- Test AppContext, with the loop's MCP base URL late-bound to the app port ---
      let mcpBaseUrl = '';
      ctx = await createTestContext({
        getMcpBaseUrl: () => mcpBaseUrl,
        // Real mkdtemp-style directory (Bun.spawnSync(['mkdir', '-p', ...])),
        // not seeded in any fixture -- and a sibling e2e-native file's
        // transitive mock-fs-helper import routes fs/promises through memfs
        // for this whole process regardless. This test doesn't exercise the
        // cwd-existence check itself (Issue #1892).
        assertSpawnCwdFn: async () => {},
      });
      const owner = await ctx.userRepository.upsertByOsUid(65432, 'owner', '/home/owner');

      // --- Fixture 2: real app server (real /api router + real /mcp app) ---
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

      // The subprocess cwd must exist on the REAL filesystem. Server-side fs
      // is memfs-mocked, so create the dir via a real spawn.
      realCwd = path.join(os.tmpdir(), `ac-interrupted-parent-e2e-${crypto.randomUUID()}`);
      Bun.spawnSync(['mkdir', '-p', realCwd]);

      // --- Two definitions pointed at the SAME stub, distinguished by model ---
      const parentDef = await ctx.embeddedAgentManager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Parent model', provider: { baseUrl: `${stubBaseUrl}/v1`, model: PARENT_MODEL } },
        owner.id,
      );
      const childDef = await ctx.embeddedAgentManager.createEmbeddedAgent(
        { engine: 'openai-api', name: 'Child model', provider: { baseUrl: `${stubBaseUrl}/v1`, model: CHILD_MODEL } },
        owner.id,
      );

      // --- Session P: the delegating parent ---
      const pSession = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd, embeddedAgentId: parentDef.id },
        { createdBy: owner.id },
      );
      const pWorkerId = pSession.workers.find((w) => w.type === 'embedded-agent')!.id;
      await ctx.sessionManager.activateEmbeddedAgentWorker(pSession.id, pWorkerId);

      // --- Session C: a child delegated by P, whose turn will hang mid-flight ---
      const cSession = await ctx.sessionManager.createSession(
        {
          type: 'quick',
          locationPath: realCwd,
          embeddedAgentId: childDef.id,
          parentSessionId: pSession.id,
          parentWorkerId: pWorkerId,
        },
        { createdBy: owner.id },
      );
      const cWorkerId = cSession.workers.find((w) => w.type === 'embedded-agent')!.id;
      await ctx.sessionManager.activateEmbeddedAgentWorker(cSession.id, cWorkerId);

      const sent = await ctx.sessionManager.sendEmbeddedAgentUserMessage(
        cSession.id,
        cWorkerId,
        'please hang forever',
      );
      expect(sent.ok).toBe(true);
      if (!sent.ok || !('id' in sent)) throw new Error('expected sendEmbeddedAgentUserMessage to succeed with an id');
      const cTurnId = sent.id;

      // Wait until the hanging request has genuinely reached the stub --
      // proof the turn is mid-flight at the socket level, not merely queued
      // in-process.
      await waitFor(() => childRequestsSeen >= 1);

      const parentRequestCountBeforeKill = requestLog.filter((b) => b.model === PARENT_MODEL).length;

      // --- Kill C's real engine process out from under the hanging turn ---
      const cInternal = ctx.sessionManager.getWorker(cSession.id, cWorkerId);
      const cShellPid = cInternal && cInternal.type === 'embedded-agent' ? cInternal.subprocess?.pid : undefined;
      expect(cShellPid).toBeDefined();
      if (cShellPid === undefined) throw new Error('expected a live subprocess pid for session C');
      const cEnginePid = await findEnginePid(cShellPid);
      process.kill(cEnginePid, 'SIGKILL');

      // --- C's own stream records the exit it suffered ---
      await waitFor(async () => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(cSession.id, cWorkerId);
        return !!hist && hist.data.includes('"type":"exited"');
      });
      const cHistory = await ctx.sessionManager.getWorkerOutputHistory(cSession.id, cWorkerId);
      expect(cHistory).not.toBeNull();
      expect((cHistory!.data as string)).toContain('"reason":"unexpected"');

      // --- P receives the interrupted-turn notification as a real turn ---
      await waitFor(() => requestLog.filter((b) => b.model === PARENT_MODEL).length > parentRequestCountBeforeKill);
      const notificationRequest = requestLog
        .filter((b) => b.model === PARENT_MODEL)
        .slice(parentRequestCountBeforeKill)[0];
      expect(notificationRequest).toBeDefined();
      const notificationMessageText = JSON.stringify(notificationRequest?.messages ?? []);
      expect(notificationMessageText).toContain('[internal:worker-interrupted]');
      expect(notificationMessageText).toContain(`turnId=${cTurnId}`);
      expect(notificationMessageText).toContain('cause=exit');
      expect(notificationMessageText).toContain('exitReason=unexpected');

      await waitFor(async () => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(pSession.id, pWorkerId);
        return !!hist && hist.data.includes('internal-worker-interrupted');
      });
      const pHistoryAfterKill = await ctx.sessionManager.getWorkerOutputHistory(pSession.id, pWorkerId);
      expect(pHistoryAfterKill).not.toBeNull();
      const pNotificationLine = (pHistoryAfterKill!.data as string)
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.type === 'user-message' && (e.notification as Record<string, unknown> | undefined)?.kind === 'internal-worker-interrupted');
      expect(pNotificationLine).toBeDefined();

      const parentRequestCountAfterNotification = requestLog.filter((b) => b.model === PARENT_MODEL).length;

      // --- Reactivate C (simulating "server restart, worker comes back") ---
      await ctx.sessionManager.activateEmbeddedAgentWorker(cSession.id, cWorkerId);
      await waitFor(async () => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(cSession.id, cWorkerId);
        return !!hist && hist.data.includes('"type":"turn-interrupted"');
      });

      // No second notification: the server already observed C's exit via
      // Site 1, so Site 2 (the restore branch) must not re-notify P.
      await delay(500);
      expect(requestLog.filter((b) => b.model === PARENT_MODEL).length).toBe(parentRequestCountAfterNotification);

      // polarity: temporarily commenting out the Site 1 notification call's
      // condition in handleExit (`if (wasMidTurn && ...)`) made the "P
      // receives the interrupted-turn notification" waitFor above time out
      // (20s) instead of passing in ~2s; restored after confirming the
      // failure. Confirmed 2026-10-08.

      // --- Negative control: session D, same parentage, killed while IDLE ---
      const dSession = await ctx.sessionManager.createSession(
        {
          type: 'quick',
          locationPath: realCwd,
          embeddedAgentId: childDef.id,
          parentSessionId: pSession.id,
          parentWorkerId: pWorkerId,
        },
        { createdBy: owner.id },
      );
      const dWorkerId = dSession.workers.find((w) => w.type === 'embedded-agent')!.id;
      await ctx.sessionManager.activateEmbeddedAgentWorker(dSession.id, dWorkerId);

      const dInternal = ctx.sessionManager.getWorker(dSession.id, dWorkerId);
      const dShellPid = dInternal && dInternal.type === 'embedded-agent' ? dInternal.subprocess?.pid : undefined;
      expect(dShellPid).toBeDefined();
      if (dShellPid === undefined) throw new Error('expected a live subprocess pid for session D');
      const dEnginePid = await findEnginePid(dShellPid);

      const parentRequestCountBeforeIdleKill = requestLog.filter((b) => b.model === PARENT_MODEL).length;
      process.kill(dEnginePid, 'SIGKILL');

      await waitFor(async () => {
        const hist = await ctx!.sessionManager.getWorkerOutputHistory(dSession.id, dWorkerId);
        return !!hist && hist.data.includes('"type":"exited"');
      });

      await delay(500);
      expect(requestLog.filter((b) => b.model === PARENT_MODEL).length).toBe(parentRequestCountBeforeIdleKill);
    },
    60_000,
  );
});
