#!/usr/bin/env bun
/**
 * Shipping-path E2E for restart-all's inclusion of embedded-agent workers
 * (Issue #1519).
 *
 * Modeled closely on `check-embedded-agent-idle-eviction.ts` -- same
 * disposable-server boilerplate, same two-worker positive/negative-control
 * shape, same tool-planted-nonce + closed-second-route recall discipline.
 * What differs is the mechanism under test: `SessionManager.restartAllAgentWorkers`
 * (the same method `restart_all_agents` and `POST
 * /api/sessions/restart-all-agents` both call) restarting an ACTIVE
 * embedded-agent worker via the ordinary deactivate-then-activate path,
 * instead of idle eviction's countdown-driven deactivate.
 *
 * Everything here is real: a real `AppContext`, a real app server with the
 * real `/api` router and real `/mcp` app, real `claude-sdk` embedded-agent
 * workers spawned by the real `EmbeddedAgentWorkerService`, the real Claude
 * Agent SDK talking to the real Anthropic API, and a real
 * `SessionManager.restartAllAgentWorkers()` call -- the same entry point the
 * MCP tool and the REST route both reach.
 *
 * WHAT IT ASSERTS
 *
 *   Fresh incarnation (positive):
 *     - A's harness process after restart-all has a DIFFERENT pid than
 *       before -- proof this is a genuinely new subprocess, not the same one
 *       left running.
 *     - A's persisted stream carries an `exited` row for the pre-restart
 *       incarnation, stamped `reason: 'managed'` (an ordinary deactivate,
 *       NOT `'evicted'` -- restart-all is not idle eviction).
 *     - `restartAllAgentWorkers()`'s own result reports A as
 *       `{ workerType: 'embedded-agent', outcome: 'restarted' }`.
 *
 *   Transparent recall (this is what makes the fresh incarnation a RESUME,
 *   not merely "the old one died and nobody replaced it"):
 *     - The fresh incarnation, asked to recall a nonce planted (via a TOOL
 *       call, not chat text) before the restart, produces it.
 *
 *   Recall control (this is what makes A's recall attributable to resume
 *   rather than to guessability):
 *     - B, a second embedded-agent worker that never heard the nonce, is
 *       asked the SAME question after also being restarted by the same
 *       restart-all call, and must NOT produce it.
 *
 * There is no idle-threshold substitution here (unlike the idle-eviction
 * smoke) -- restart-all is not time-driven, so there is nothing analogous to
 * substitute.
 *
 * COST: three real Claude turns (one to plant+use-a-tool, one to recall for
 * A, one recall-control for B). Small, but real money and real usage -- this
 * is a manual tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - A real, authenticated `claude` CLI for the invoking OS user (the
 *     `claude-sdk` builtin runs as the executing user and uses that user's
 *     own authentication -- there is no API key to configure).
 *   - `bun install` already run in this checkout.
 *   - Linux /proc (the pid-liveness assertion reads it directly).
 *
 * USAGE
 *   bun scripts/smoke/check-restart-all-embedded.ts
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- deliberately distinct from 1, so an operator can tell
 *      "restart-all is broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every module that transitively imports server-config.ts must be
// loaded via a DYNAMIC import made from inside main(), not a static import
// at the top of this file. Same hazard, same remedy as the sibling smokes
// (see check-embedded-agent-idle-eviction.ts's header comment for the full
// account).

import { unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const NONCE = `NARWHAL-${Math.floor(Math.random() * 9000 + 1000)}`;
/**
 * The file the planting turn reads. Routed through a tool rather than
 * carried in the message text itself, per
 * `.claude/rules/test-trigger.md`'s "the conversation must use a tool" rule
 * -- a text-only exchange cannot exercise the event order a tool-using turn
 * writes.
 */
const NONCE_FILE = 'qa-note.txt';
const PLANT_TEXT =
  `Use the Read tool to read ${NONCE_FILE} in the current directory, then remember ` +
  'the secret word it contains. Reply with only the word OK.';
const RECALL_TEXT =
  'Do you have a secret word available to you right now? ' +
  'Answer with the word itself, or the single word UNKNOWN if you do not have one.';
const CONTROL_TEXT = RECALL_TEXT;

const failures: string[] = [];
let passes = 0;

function expect(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Ad-hoc invocation inherits the caller's cwd, which the spawn machinery
  // evaluates; an unreadable inherited cwd produces EACCES on posix_spawn.
  // Neutralized at script start, same as the sibling smokes.
  process.chdir('/');

  // --- Deferred imports: everything below transitively reaches server-config.ts.
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agent-manager.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import(
    '../../packages/server/src/services/worktree-deletion-service.js'
  );

  // `hono` is hoisted under packages/server/node_modules, not under any
  // node_modules ancestor of scripts/smoke/ -- resolve it the way
  // packages/server would and import the resolved absolute path.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realConfigDir: string | undefined;
  let realCwd: string | undefined;

  try {
    console.log(`==> nonce: ${NONCE}`);

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-restart-all-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    realCwd = path.join(os.tmpdir(), `ac-restart-all-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);
    // The planting turn reads this rather than being told the nonce directly,
    // so the turn actually uses a tool. See NONCE_FILE.
    await Bun.write(path.join(realCwd, NONCE_FILE), `The secret word is ${NONCE}.\n`);

    const app = new Hono();
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    app.route(
      '',
      createMcpApp({
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
      }),
    );

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    // --- Two sessions, one `claude-sdk` worker each. Separate sessions
    // rather than two workers in one, so the control worker's CONVERSATION
    // cannot share anything with the subject's by construction.
    //
    // Their FILESYSTEM is shared: both are created on `realCwd`. That is why
    // the nonce file is deleted once the planting turn has read it -- while
    // it existed, B could have answered from the file rather than from
    // ignorance.
    const makeWorker = async (label: string): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      });
      if (!worker) throw new Error(`createWorker returned null for ${label}`);
      return { sessionId: session.id, workerId: worker.id };
    };

    const readEvents = async (
      sessionId: string,
      workerId: string,
    ): Promise<Array<Record<string, unknown> & { type: string }>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      const events: Array<Record<string, unknown> & { type: string }> = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') {
            events.push(json as Record<string, unknown> & { type: string });
          }
        } catch {
          // A trailing torn line is expected while the stream is live.
        }
      }
      return events;
    };

    /** Drive one turn and return the assistant text it produced. */
    const runTurn = async (
      sessionId: string,
      workerId: string,
      text: string,
      timeoutMs = 120_000,
    ): Promise<string> => {
      const before = (await readEvents(sessionId, workerId)).length;
      const res = await ctx!.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, text);
      if (!res.ok) throw new Error(`sendEmbeddedAgentUserMessage failed: ${res.code} ${res.error}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(before);
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal) throw new Error(`loop emitted fatal: ${JSON.stringify(fatal)}`);
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr) throw new Error(`loop emitted turn-error: ${JSON.stringify(turnErr)}`);
        const sawIdle = events.some((e) => e.type === 'state' && e.state === 'idle');
        if (sawIdle) {
          return events
            .filter((e) => e.type === 'assistant-message')
            .map((e) => String(e.text ?? ''))
            .join('\n');
        }
        await delay(500);
      }
      throw new Error('turn did not complete before the deadline');
    };

    const harnessPid = (sessionId: string, workerId: string): number | null => {
      const w = ctx!.sessionManager.getWorker(sessionId, workerId);
      if (!w || w.type !== 'embedded-agent') return null;
      const sub = (w as { subprocess?: { pid?: number } | null }).subprocess;
      return sub?.pid ?? null;
    };

    // --- Subject A: activate, plant the nonce via a tool call.
    console.log('==> subject A: activate + plant nonce');
    const a = await makeWorker('A');
    await ctx.sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
    const aHarnessBefore = harnessPid(a.sessionId, a.workerId);
    if (aHarnessBefore === null) throw new Error('A has no subprocess after activation');

    const plantMarker = (await readEvents(a.sessionId, a.workerId)).length;
    const plantReply = await runTurn(a.sessionId, a.workerId, PLANT_TEXT);
    const plantEvents = (await readEvents(a.sessionId, a.workerId)).slice(plantMarker);
    expect(
      plantEvents.some((e) => e.type === 'tool-call'),
      'the planting turn actually called a tool',
      `events after the plant: ${plantEvents.map((e) => e.type).join(',')}`,
    );

    // The nonce now exists in TWO places: A's conversation, and the file.
    // Only the first is under test, so the second is removed the moment the
    // planting turn has used it -- otherwise the recall below has a second,
    // silent route to green (the woken worker reads the file back).
    unlinkSync(path.join(realCwd!, NONCE_FILE));
    console.log(`  A harness pid (before restart): ${aHarnessBefore}`);
    console.log(`  A plant reply: ${plantReply.trim().slice(0, 120)}`);

    // --- Control B: activated, never told the nonce.
    console.log('==> control B: activate (never hears the nonce)');
    const b = await makeWorker('B');
    await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
    const bHarnessBefore = harnessPid(b.sessionId, b.workerId);
    if (bHarnessBefore === null) throw new Error('B has no subprocess after activation');
    console.log(`  B harness pid (before restart): ${bHarnessBefore}`);

    // --- The mechanism under test: restart-all.
    console.log('==> calling SessionManager.restartAllAgentWorkers()');
    const result = await ctx.sessionManager.restartAllAgentWorkers();
    console.log(`  result: ${JSON.stringify(result)}`);

    expect(
      result.results.some(
        (r) => r.workerId === a.workerId && r.workerType === 'embedded-agent' && r.outcome === 'restarted',
      ),
      "A: restartAllAgentWorkers() reports { workerType: 'embedded-agent', outcome: 'restarted' }",
      `got ${JSON.stringify(result.results.filter((r) => r.workerId === a.workerId))}`,
    );
    expect(
      result.results.some(
        (r) => r.workerId === b.workerId && r.workerType === 'embedded-agent' && r.outcome === 'restarted',
      ),
      "B: restartAllAgentWorkers() reports { workerType: 'embedded-agent', outcome: 'restarted' }",
      `got ${JSON.stringify(result.results.filter((r) => r.workerId === b.workerId))}`,
    );

    // --- Fresh incarnation, positive: a genuinely different pid.
    const aHarnessAfter = harnessPid(a.sessionId, a.workerId);
    console.log(`  A harness pid (after restart): ${aHarnessAfter}`);
    expect(
      aHarnessAfter !== null && aHarnessAfter !== aHarnessBefore,
      'A: restart produced a genuinely fresh incarnation (different harness pid)',
      `before=${aHarnessBefore} after=${aHarnessAfter}`,
    );

    // --- The pre-restart incarnation's exit was observed and classified as
    // an ORDINARY deactivate, not an eviction -- restart-all is not idle
    // eviction, and this is what tells the two apart in the persisted stream.
    const aEvents = await readEvents(a.sessionId, a.workerId);
    const aExitedRows = aEvents.filter((e) => e.type === 'exited');
    expect(
      aExitedRows.length >= 1,
      'A: at least one `exited` row was appended for the pre-restart incarnation',
      `got ${aExitedRows.length}`,
    );
    expect(
      aExitedRows[0]?.reason === 'managed',
      "A: the pre-restart incarnation's `exited` row is stamped reason: 'managed' (not 'evicted')",
      `got ${JSON.stringify(aExitedRows[0])}`,
    );

    // --- Transparent recall: the fresh incarnation resumes the conversation.
    console.log('==> asking A (fresh incarnation) to recall the nonce');
    const recallMarker = (await readEvents(a.sessionId, a.workerId)).length;
    const recallReply = await runTurn(a.sessionId, a.workerId, RECALL_TEXT);
    console.log(`  A recall reply: ${recallReply.trim().slice(0, 200)}`);
    expect(
      recallReply.includes(NONCE),
      'A: the freshly-restarted incarnation recalled the nonce planted before the restart',
      `expected ${NONCE} in: ${recallReply.trim().slice(0, 300)}`,
    );
    // Deleting the file closed the route; this measures that it stayed closed.
    const recallEvents = (await readEvents(a.sessionId, a.workerId)).slice(recallMarker);
    expect(
      !recallEvents.some((e) => e.type === 'tool-call'),
      'A: the recall came from the resumed conversation, not from a tool reading the file back',
      `events: ${recallEvents.map((e) => e.type).join(',')}`,
    );

    // --- Recall control: B never heard the nonce and must not produce it,
    // even though it was ALSO restarted by the same call. This is what makes
    // A's recall attributable to resume rather than to guessability.
    console.log('==> recall control: asking B (also restarted) the same question');
    const controlMarker = (await readEvents(b.sessionId, b.workerId)).length;
    const controlReply = await runTurn(b.sessionId, b.workerId, CONTROL_TEXT);
    console.log(`  B control reply: ${controlReply.trim().slice(0, 200)}`);
    expect(
      !controlReply.includes(NONCE),
      'B (recall control): did NOT produce the nonce',
      `got: ${controlReply.trim().slice(0, 300)}`,
    );
    const controlEvents = (await readEvents(b.sessionId, b.workerId)).slice(controlMarker);
    expect(
      !controlEvents.some((e) => e.type === 'tool-call'),
      'B (recall control): answered from ignorance, not from a tool',
      `events: ${controlEvents.map((e) => e.type).join(',')}`,
    );
  } finally {
    if (ctx) {
      for (const s of ctx.sessionManager.getAllSessions()) {
        for (const w of s.workers) {
          if (w.type === 'embedded-agent') {
            await ctx.sessionManager.deactivateEmbeddedAgentWorker(s.id, w.id).catch(() => {});
          }
        }
      }
      await shutdownAppContext(ctx).catch(() => {});
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    for (const dir of [realConfigDir, realCwd]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then(() => {
      console.log(`\n==> ${passes} passed, ${failures.length} failed`);
      if (failures.length > 0) {
        for (const f of failures) console.error(`  FAILED: ${f}`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nPROBE COULD NOT RUN (or aborted before completing its assertions):');
      console.error(err);
      console.error(`\n==> ${passes} passed, ${failures.length} failed before the abort`);
      process.exit(2);
    });
}
