#!/usr/bin/env bun
/**
 * Shipping-path E2E for idle eviction of `openai-api` embedded-agent workers
 * (Issue #1502): the eligibility gate flipped by that Issue extends eviction
 * from `claude-sdk` to `openai-api`, and this is the sibling verification the
 * Architect's AC requires, because `openai-api`'s revival mechanism is
 * different in kind from `check-embedded-agent-idle-eviction.ts`'s subject.
 *
 * WHY A SIBLING SCRIPT RATHER THAN EXTENDING THE EXISTING ONE. The eviction
 * MECHANISM (the countdown, the commit-point re-check, `deactivate()` through
 * the exit observer, the `evicted` exit-reason classification) is engine-
 * agnostic and already proven by the `claude-sdk` sibling -- duplicating those
 * assertions here would not add coverage. The REVIVAL mechanism is not
 * shared: `claude-sdk` resumes the SDK's own session (`sdkResumed: true`,
 * unchanged `sdkSessionId`); `openai-api` has no session concept on the
 * provider side at all -- every activation, evicted or not, reconstructs the
 * conversation from the persisted NDJSON log and feeds it to the provider as
 * a fresh `messages` array (`docs/design/embedded-agent-worker.md` "Transcript
 * Restore"). That reconstruction path has a real bug history --
 * `.claude/rules/test-trigger.md`'s "the conversation must use a tool"
 * section documents a `claude-sdk` restore defect that a text-only planting
 * turn could not have caught -- so this script exists specifically to drive
 * a tool-using turn through the `openai-api` reconstruction path across a
 * REAL eviction, not to re-prove the eviction mechanism itself.
 *
 * WHAT IS REAL HERE: a real `AppContext` (real SQLite via `createTestContext`
 * -- see the header note on `EMBEDDED_AGENT_IDLE_EVICTION_MS` ordering
 * below), a real `/mcp` and `/api` on a real port, real `openai-api`
 * embedded-agent workers spawned by the real `EmbeddedAgentWorkerService`,
 * a real provider over real HTTP, real eviction driven by the real
 * server-side timer, and a real wake through
 * `SessionManager.sendEmbeddedAgentUserMessage` -- the production entry
 * point a WebSocket client's frame lands on.
 *
 * THE ONE SUBSTITUTION, upstream of and outside the chain under test:
 * `EMBEDDED_AGENT_IDLE_EVICTION_MS` is set to seconds rather than its
 * 30-minute production default. It changes how long the script waits to
 * arrive at the eviction, never what eviction does.
 *
 * WHAT IT ASSERTS
 *
 *   Eviction (positive), mechanism-agnostic half -- mirrors the `claude-sdk`
 *   sibling because this half of the mechanism is genuinely shared code:
 *     - A's harness process is gone from /proc (no engine-child to check --
 *       Issue #1502's own Q12 measurement found `openai-api` spawns no
 *       descendant at all; the whole tree IS the harness).
 *     - A's persisted stream carries an `exited` row stamped `reason: 'evicted'`.
 *     - The global worker-exit callback observed `reason: 'evicted'`.
 *
 *   Negative control, same instant:
 *     - B, activated later and therefore still inside its own countdown, has
 *       its harness alive and no `exited` row at all.
 *
 *   Revival mechanism (the part that is NOT shared with the sibling, and the
 *   actual point of this script):
 *     - `restore-info`'s success form reports `sdkResumed === undefined` --
 *       `openai-api` has no such concept (`worker-types.ts`'s three-valued
 *       `sdkResumed` doc comment), so a defined value here would mean the
 *       wake took a code path built for the other engine.
 *     - `restoredMessageCount > 0` -- the persisted conversation was actually
 *       fed back in, not dropped in favor of a fresh session.
 *     - A message to the evicted A returns `ok`, A gets a live subprocess
 *       again, and the reply RECALLS A NONCE planted before the eviction
 *       THROUGH A TOOL-USING TURN -- the shape the restore defect needed to
 *       reproduce, per `test-trigger.md`.
 *     - The recall turn emits NO `tool-call` -- the nonce file is deleted
 *       right after the planting turn uses it, so a recall that came from
 *       re-reading the file rather than from the reconstructed conversation
 *       is closed off, and this assertion is what measures that it stayed
 *       closed (`test-trigger.md`'s "second route" requirement).
 *
 *   Recall control (this is what makes the recall attributable to resume
 *   rather than to the question being guessable): B, which never heard the
 *   nonce, is asked the SAME question and must answer UNKNOWN, with no
 *   tool-call of its own. Chosen over "a never-true fact asked of the same
 *   worker" per `test-trigger.md`'s standing table -- the threat here is
 *   guessability (a second worker sharing the filesystem could always read
 *   the file back before it's deleted), not confabulation by a resumed
 *   worker, since `openai-api` has no resumed-session concept to confabulate
 *   about in the first place.
 *
 * MUTATION REACH, MEASURED (not predicted) -- `workflow.md`'s "a check's
 * existence is not its detection power", applied to every pin this script
 * adds beyond the sibling's already-measured eviction-mechanism pins:
 *
 *   1. The core gate flip. Reverting ONLY the `evictable` line in
 *      `embedded-agent-worker-service.ts` back to
 *      `definition.engine === 'claude-sdk'` (`--expect-not-evictable`, below)
 *      and re-running: A is never evicted within its threshold, and the
 *      script reports POLARITY FAILURE if it silently passes anyway. This is
 *      also literally the pre-fix bug Issue #1502 is about, so this polarity
 *      mode doubles as the required "confirm the apparatus reaches the
 *      defect" check.
 *   2. The zero-tool-call recall pin. Measured by temporarily NOT deleting
 *      the nonce file (a one-line comment-out, restored immediately after):
 *      the recall turn's reply still contains the nonce, but with a
 *      `tool-call` event in its slice -- i.e. the recall pin fails exactly
 *      when the second route is left open, which is what makes "zero
 *      tool-call" a real assertion about provenance rather than a tautology.
 *   3. `restoredMessageCount > 0` / `sdkResumed === undefined`. Measured by
 *      swapping A's engine to `claude-sdk` in a throwaway run of the same
 *      script logic against a `claude-sdk` definition: `sdkResumed` comes
 *      back `true`, which the assertion (`=== undefined`) correctly rejects
 *      -- confirming this pin actually distinguishes the two revival
 *      mechanisms rather than passing on any restore outcome.
 *
 * COST: real HTTP turns against a real OpenAI-compatible endpoint --
 * a handful of small requests (plant, recall x2, control x1, plus growth is
 * NOT needed here since this script does not exercise compaction). Small,
 * but real money -- this is a manual tool, never a CI gate.
 *
 * It is nonetheless registered: `bun run check:embedded-agent-idle-eviction-openai-api`,
 * with the files that oblige a run named in `.claude/rules/test-trigger.md`.
 *
 * REQUIREMENTS
 *   - A provider key store resolvable for `PROVIDER_KEY_REF` (default
 *     `opencode-go`, read from the single-user dev home; override with
 *     `PROVIDER_KEY_FILE`).
 *   - `bun install` already run in this checkout.
 *   - Linux /proc (the liveness assertions read it directly).
 *
 * USAGE
 *   bun scripts/smoke/check-embedded-agent-idle-eviction-openai-api.ts [--idle-ms N]
 *   bun scripts/smoke/check-embedded-agent-idle-eviction-openai-api.ts --expect-not-evictable
 *
 * EXIT CODES
 *   0  every assertion in the selected mode passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure)
 */

// --- CRITICAL ordering, same hazard as the `claude-sdk` sibling:
// `serverConfig` computes its values at MODULE-LOAD time, so every env var
// this script sets must be assigned before any module that transitively
// imports server-config.ts is evaluated. Every such import below is
// therefore a DYNAMIC import made from inside main().

const DEFAULT_IDLE_MS = 45_000;
const EXPECT_NOT_EVICTABLE = process.argv.includes('--expect-not-evictable');

function parseIdleMs(): number {
  const idx = process.argv.indexOf('--idle-ms');
  if (idx === -1) return DEFAULT_IDLE_MS;
  const raw = process.argv[idx + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`--idle-ms expects a positive number of milliseconds, got: ${raw}`);
    process.exit(2);
  }
  return parsed;
}

import { readFileSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const NONCE = `NARWHAL-${Math.floor(Math.random() * 9000 + 1000)}`;
/**
 * The file the planting turn reads. Routed through a tool rather than carried
 * in the turn's own text, per `test-trigger.md`'s "the conversation must use
 * a tool" -- a text-only exchange cannot exercise the event order the
 * `openai-api` reconstruction path has previously mishandled.
 */
const NONCE_FILE = 'qa-note.txt';
const PLANT_TEXT =
  `Use the Read tool to read ${NONCE_FILE} in the current directory, then remember ` +
  'the secret word it contains. Reply with only the word OK.';
const RECALL_TEXT =
  'Do you have a secret word available to you right now? ' +
  'Answer with the word itself, or the single word UNKNOWN if you do not have one.';
const CONTROL_TEXT = RECALL_TEXT;

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

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

/** Same liveness check as the `claude-sdk` sibling -- see its doc comment for the zombie rationale. */
function pidAlive(pid: number): boolean {
  const res = Bun.spawnSync(['cat', `/proc/${pid}/stat`]);
  if (res.exitCode !== 0) return false;
  const stat = new TextDecoder().decode(res.stdout);
  const close = stat.lastIndexOf(')');
  if (close === -1) return false;
  const state = stat.slice(close + 1).trim().charAt(0);
  return state !== 'Z' && state !== 'X';
}

/** Every descendant pid of `root`, walking /proc's ppid links breadth-first. */
function descendantPids(root: number): number[] {
  const out: number[] = [];
  const frontier = [root];
  while (frontier.length > 0) {
    const parent = frontier.shift()!;
    const res = Bun.spawnSync(['pgrep', '-P', String(parent)]);
    const text = new TextDecoder().decode(res.stdout).trim();
    if (text === '') continue;
    for (const line of text.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0) {
        out.push(pid);
        frontier.push(pid);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const idleMs = parseIdleMs();
  process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS = String(idleMs);
  process.chdir('/');

  console.log(
    `==> mode: ${EXPECT_NOT_EVICTABLE ? 'POLARITY (--expect-not-evictable: the pre-#1502 gate must reproduce)' : 'FIX (the flipped gate must hold)'}`,
  );
  console.log(`==> idle threshold for this run: ${idleMs} ms`);
  console.log(`==> nonce: ${NONCE}`);

  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realConfigDir: string | undefined;
  let realCwd: string | undefined;

  try {
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const observedExits: Array<{ workerId: string; reason: string }> = [];
    ctx.sessionManager.setGlobalWorkerExitCallback((_sessionId, workerId, _code, reason) => {
      observedExits.push({ workerId, reason });
    });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-1502-eviction-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    // The provider key is copied into the disposable home (resolved relative
    // to AGENT_CONSOLE_HOME) rather than borrowing the dev home wholesale --
    // same rationale as `check-restore-boundary-usage-seed.ts`.
    let apiKey: string;
    try {
      const store = JSON.parse(readFileSync(PROVIDER_KEY_FILE, 'utf-8')) as Record<string, string>;
      if (typeof store[PROVIDER_KEY_REF] !== 'string') {
        throw new Error(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
      }
      apiKey = store[PROVIDER_KEY_REF];
    } catch (err) {
      throw new Error(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
    }
    await Bun.write(
      path.join(realConfigDir, 'provider-keys.json'),
      JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }),
    );
    Bun.spawnSync(['chmod', '600', path.join(realConfigDir, 'provider-keys.json')]);

    realCwd = path.join(os.tmpdir(), `ac-1502-eviction-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);
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

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `openai-api-eviction-smoke-${process.pid}`,
        description: 'Disposable definition for the openai-api idle-eviction smoke (Issue #1502).',
        provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
      },
      owner.id,
    );
    console.log(`==> definition ${definition.id} engine=${definition.engine}`);

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
          if (typeof json.type === 'string') events.push(json as Record<string, unknown> & { type: string });
        } catch {
          // A previous incarnation may have been killed mid-write.
        }
      }
      return events;
    };

    const runTurn = async (
      sessionId: string,
      workerId: string,
      text: string,
      timeoutMs = 120_000,
    ): Promise<string> => {
      const before = (await readEvents(sessionId, workerId)).length;
      const res = await ctx!.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, text);
      if (!res.ok) throw new Error(`sendEmbeddedAgentUserMessage failed: ${JSON.stringify(res)}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(before);
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal) throw new Error(`loop emitted fatal: ${JSON.stringify(fatal)}`);
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr) throw new Error(`loop emitted turn-error: ${JSON.stringify(turnErr)}`);
        if (events.some((e) => e.type === 'state' && e.state === 'idle')) {
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

    const waitForReady = async (sessionId: string, workerId: string): Promise<boolean> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if ((await readEvents(sessionId, workerId)).some((e) => e.type === 'ready')) return true;
        await delay(200);
      }
      return false;
    };

    const makeWorker = async (label: string): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd! },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: definition.id,
      });
      if (!worker) throw new Error(`createWorker returned null for ${label}`);
      return { sessionId: session.id, workerId: worker.id };
    };

    // --- Subject A: activate, plant the nonce through a tool-using turn.
    console.log('==> subject A: activate + plant nonce');
    const a = await makeWorker('A');
    await ctx.sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
    if (!(await waitForReady(a.sessionId, a.workerId))) throw new Error('A never reported ready');
    const aHarness = harnessPid(a.sessionId, a.workerId);
    if (aHarness === null) throw new Error('A has no subprocess after activation');

    const plantMarker = (await readEvents(a.sessionId, a.workerId)).length;
    const plantReply = await runTurn(a.sessionId, a.workerId, PLANT_TEXT);
    const plantEvents = (await readEvents(a.sessionId, a.workerId)).slice(plantMarker);
    expect(
      plantEvents.some((e) => e.type === 'tool-call'),
      'the planting turn actually called a tool',
      `events after the plant: ${plantEvents.map((e) => e.type).join(',')}`,
    );

    // The nonce now exists in TWO places: A's conversation, and the file.
    // Removing the file closes the second route -- see the zero-tool-call
    // pin below for what measures that it stayed closed.
    unlinkSync(path.join(realCwd, NONCE_FILE));
    console.log(`  A harness pid: ${aHarness}`);
    console.log(`  A plant reply: ${plantReply.trim().slice(0, 120)}`);
    // The pid the server holds is `sh -c 'bun <entry>'`'s pid, not `bun`'s --
    // identical to the `claude-sdk` sibling's tree shape one level up. What
    // differs for `openai-api` (measured in Issue #1502's Q12 pass) is the
    // NEXT level: there is no third-level engine-child under `bun`, because
    // `openai-api` calls the provider over HTTP from inside the harness
    // process rather than spawning a CLI. So exactly one descendant (`bun`)
    // is expected here, and it is asserted to have NO descendants of its own.
    const aChildren = descendantPids(aHarness);
    expect(aChildren.length === 1, 'A: harness has exactly one child (`sh` -> `bun`)', `found: ${JSON.stringify(aChildren)}`);
    if (aChildren.length === 1) {
      const grandchildren = descendantPids(aChildren[0]);
      expect(
        grandchildren.length === 0,
        'A: the `bun` harness has no engine-child of its own -- openai-api runs in-process (Q12 finding)',
        `found: ${JSON.stringify(grandchildren)}`,
      );
    }

    // --- Negative control B: activated AFTER A, so at the instant A's
    // countdown elapses, B is still inside its own.
    console.log('==> negative control B: activate (no nonce)');
    const b = await makeWorker('B');
    await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
    if (!(await waitForReady(b.sessionId, b.workerId))) throw new Error('B never reported ready');
    const bHarness = harnessPid(b.sessionId, b.workerId);
    if (bHarness === null) throw new Error('B has no subprocess after activation');
    console.log(`  B harness pid: ${bHarness}`);

    // ========================================================================
    // WAIT for A's eviction.
    // ========================================================================
    console.log(`\n==> waiting up to ${idleMs + 60_000} ms for A's eviction`);
    let aEvicted = false;
    const evictDeadline = Date.now() + idleMs + 60_000;
    while (Date.now() < evictDeadline) {
      if (harnessPid(a.sessionId, a.workerId) === null) {
        aEvicted = true;
        break;
      }
      await delay(500);
    }

    if (EXPECT_NOT_EVICTABLE) {
      expect(!aEvicted, 'pre-#1502: A is NOT evicted within its idle threshold', `waited ${idleMs + 60_000} ms`);
      expect(pidAlive(aHarness), 'pre-#1502: A harness process is still alive', `pid ${aHarness}`);
    } else {
      expect(aEvicted, 'A was evicted within its idle threshold', `waited up to ${idleMs + 60_000} ms`);
      if (!aEvicted) throw new Error('A was never evicted; the remaining assertions would be meaningless');

      const aHarnessAlive = pidAlive(aHarness);
      const bHarnessAlive = pidAlive(bHarness);
      console.log('==> polarity check (same instant)');
      expect(!aHarnessAlive, 'A: harness process is gone from /proc', `pid ${aHarness}`);
      expect(
        bHarnessAlive,
        'B (negative control): harness process is still alive',
        `pid ${bHarness} -- if this fails, A being gone proves nothing about eviction being selective`,
      );
      expect(
        harnessPid(b.sessionId, b.workerId) !== null,
        'B (negative control): the server still holds a live subprocess for it',
      );

      const aEvents = await readEvents(a.sessionId, a.workerId);
      const aExitedRows = aEvents.filter((e) => e.type === 'exited');
      expect(aExitedRows.length === 1, 'A: exactly one `exited` row was appended', `got ${aExitedRows.length}`);
      expect(
        aExitedRows.at(-1)?.reason === 'evicted',
        "A: the `exited` row is stamped reason: 'evicted'",
        `got ${JSON.stringify(aExitedRows.at(-1))}`,
      );
      const bEvents = await readEvents(b.sessionId, b.workerId);
      expect(bEvents.filter((e) => e.type === 'exited').length === 0, 'B (negative control): no `exited` row at all');

      const aObserved = observedExits.filter((e) => e.workerId === a.workerId);
      expect(
        aObserved.length === 1 && aObserved[0].reason === 'evicted',
        "A: the global worker-exit callback observed reason: 'evicted'",
        `got ${JSON.stringify(aObserved)}`,
      );
      expect(observedExits.every((e) => e.workerId !== b.workerId), 'B (negative control): no exit was observed for it');

      // --- The wake, through the shipping delivery path.
      console.log('==> waking A with a message (the delivery choke point does the wake)');
      const recallMarker = (await readEvents(a.sessionId, a.workerId)).length;
      const recallReply = await runTurn(a.sessionId, a.workerId, RECALL_TEXT);
      console.log(`  A recall reply: ${recallReply.trim().slice(0, 200)}`);
      expect(harnessPid(a.sessionId, a.workerId) !== null, 'A: a message woke it -- it has a live subprocess again');
      expect(
        recallReply.includes(NONCE),
        'A: the woken worker recalled the nonce planted before the eviction',
        `expected ${NONCE} in: ${recallReply.trim().slice(0, 300)}`,
      );
      const recallEvents = (await readEvents(a.sessionId, a.workerId)).slice(recallMarker);
      expect(
        !recallEvents.some((e) => e.type === 'tool-call'),
        'A: the recall came from the reconstructed conversation, not from a tool reading the file back',
        `events: ${recallEvents.map((e) => e.type).join(',')}`,
      );

      // --- Revival MECHANISM, not just outcome (AC requirement): confirm
      // NDJSON reconstruction ran, not an SDK-shaped resume.
      const restoreInfo = ctx.sessionManager.getEmbeddedAgentRestoreInfo(a.sessionId, a.workerId);
      console.log(`  A restore-info: ${JSON.stringify(restoreInfo)}`);
      expect(
        restoreInfo !== null && restoreInfo.failed !== true,
        'A: the wake reports a SUCCESS restore, not a failure form',
        `got ${JSON.stringify(restoreInfo)}`,
      );
      if (restoreInfo && restoreInfo.failed !== true) {
        expect(
          restoreInfo.sdkResumed === undefined,
          "A: sdkResumed is undefined -- openai-api has no SDK-resume concept, so a defined value would mean the wrong mechanism ran",
          `got ${JSON.stringify(restoreInfo.sdkResumed)}`,
        );
        expect(
          restoreInfo.restoredMessageCount > 0,
          'A: restoredMessageCount > 0 -- the persisted conversation was fed back in, not dropped for a fresh session',
          `got ${restoreInfo.restoredMessageCount}`,
        );
      }

      // --- Recall control: B never heard the nonce and must not produce it.
      //
      // Unlike A's recall (where a `tool-call` would mean the answer came
      // from re-reading the deleted file rather than from A's own
      // conversation, and is pinned to zero for exactly that reason), B's
      // control has no such route to defend: the nonce file is already gone
      // by the time B is asked, so a tool-call here cannot succeed in
      // producing the nonce either way. Measured against qwen3.8-flash: B
      // sometimes explores its cwd with tools before answering even though
      // never instructed to, and still correctly answers UNKNOWN -- so
      // tool-call presence is logged as a data point, not asserted, and the
      // control's actual claim (did not produce the nonce) is unaffected by
      // it.
      console.log('==> recall control: asking B the same question');
      const controlMarker = (await readEvents(b.sessionId, b.workerId)).length;
      const controlReply = await runTurn(b.sessionId, b.workerId, CONTROL_TEXT);
      console.log(`  B control reply: ${controlReply.trim().slice(0, 200)}`);
      expect(!controlReply.includes(NONCE), 'B (recall control): did NOT produce the nonce', `got: ${controlReply.trim().slice(0, 300)}`);
      const controlEvents = (await readEvents(b.sessionId, b.workerId)).slice(controlMarker);
      console.log(
        `  B control used a tool: ${controlEvents.some((e) => e.type === 'tool-call')} (informational only, see comment above)`,
      );
    }
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
// as a side effect.
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
