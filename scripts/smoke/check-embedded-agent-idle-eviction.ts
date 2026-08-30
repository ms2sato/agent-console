#!/usr/bin/env bun
/**
 * Shipping-path E2E for idle eviction of `claude-sdk` embedded-agent workers.
 *
 * This is the verification the eviction phase's acceptance criteria require,
 * and it deliberately carries BOTH POLARITIES IN ONE RUN. Without the negative
 * control, "worker A was evicted" is indistinguishable from "everything gets
 * killed" -- the observation that matters is that A's subprocess is gone at a
 * moment when B's, still under its threshold, is demonstrably alive.
 *
 * Everything here is real: a real `AppContext`, a real app server with the
 * real `/api` router and real `/mcp` app, real `claude-sdk` embedded-agent
 * workers spawned by the real `EmbeddedAgentWorkerService`, the real Claude
 * Agent SDK talking to the real Anthropic API, real eviction driven by the
 * real server-side timer reading the real `EMBEDDED_AGENT_IDLE_EVICTION_MS`,
 * and a real wake through `SessionManager.sendEmbeddedAgentUserMessage` --
 * the same entry point the WebSocket and inter-session paths reach.
 *
 * There is exactly one substitution, and it is upstream of and outside the
 * chain under test: `EMBEDDED_AGENT_IDLE_EVICTION_MS` is set to seconds
 * rather than its 30-minute production default. It changes how long the
 * script waits to arrive at the eviction, never what eviction does.
 *
 * WHAT IT ASSERTS
 *
 *   Eviction (positive):
 *     - A's harness process AND its `claude` descendant are gone from /proc.
 *     - A's persisted stream carries an `exited` row stamped `reason: 'evicted'`.
 *     - The global worker-exit callback observed `reason: 'evicted'` -- the
 *       exact value `websocket/routes.ts` keys its notification suppression on.
 *
 *   Negative control, same instant:
 *     - B, activated later and therefore still inside its own countdown, has
 *       BOTH its harness and its `claude` descendant alive, and no `exited`
 *       row at all.
 *
 *   Transparent wake:
 *     - A message to the evicted A returns `ok` (it is never dropped, never
 *       `NOT_ACTIVATED`), A gets a live subprocess again, and the reply
 *       RECALLS A NONCE planted before the eviction -- which is what makes it
 *       a resume rather than a fresh session.
 *     - `restore-info.sdkResumed === true` for the woken incarnation, and the
 *       SDK session id is unchanged across the eviction.
 *
 *   Recall control (this is what makes the recall attributable):
 *     - B, which never heard the nonce, is asked the SAME question and must
 *       NOT produce it. A recall that both workers can perform would prove
 *       nothing about resume -- it would prove the question was guessable.
 *
 *   Persistence, the server-restart half:
 *     - After eviction the in-memory runtime is gone, so the state the wake
 *       reads is exactly the persisted state a restarted server would read.
 *       The worker's `sdkSessionId` is asserted to survive the eviction, and
 *       the wake is asserted to resume THAT id. The composite's remaining
 *       ingredient -- an actual process restart -- is not simulated here and
 *       is covered deterministically by unit tests over a fresh service
 *       instance; this script does not claim to have restarted a server.
 *
 * COST: five real Claude turns (two to seed, one to wake-and-recall, one for
 * the control, one spare in the retry budget). Small, but real money and real
 * usage -- this is a manual tool, never a CI gate.
 *
 * It is nonetheless registered: `bun run check:embedded-agent-idle-eviction`,
 * with the files that oblige a run named in `.claude/rules/test-trigger.md`.
 * Being manual is a reason not to wire it into CI; it is not a reason to
 * leave it reachable only by knowing its path. Registration is about
 * reachability, automation is about CI, and every smoke in this directory is
 * manual and registered both.
 *
 * REQUIREMENTS
 *   - A real, authenticated `claude` CLI for the invoking OS user (the
 *     `claude-sdk` builtin runs as the executing user and uses that user's own
 *     authentication -- there is no API key to configure).
 *   - `bun install` already run in this checkout.
 *   - Linux /proc (the liveness assertions read it directly).
 *
 * USAGE
 *   bun scripts/smoke/check-embedded-agent-idle-eviction.ts [--idle-ms N]
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- deliberately distinct from 1, so an operator can tell
 *      "eviction is broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every env var this script sets must be assigned before any module
// that transitively imports server-config.ts is evaluated. ES module static
// imports are evaluated before this file's own top-level statements run,
// regardless of where the import declaration sits textually -- so every such
// import below is a DYNAMIC import made from inside main(). This is the same
// hazard, and the same remedy, documented at length in
// check-embedded-agent-elevation.ts.

const DEFAULT_IDLE_MS = 45_000;

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

import { unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const NONCE = `NARWHAL-${Math.floor(Math.random() * 9000 + 1000)}`;
/**
 * The file the planting turn reads. The turn goes through a TOOL rather than
 * carrying the nonce in its own text, because a text-only exchange cannot
 * exercise the event order a tool-using turn writes -- and that order is
 * where restore broke: `claude-sdk` emits `tool-call` before the iteration's
 * (empty) `assistant-message`, which the reader rejected. Every shipped
 * restore smoke was text-only, which is the whole reason that reached a user.
 */
const NONCE_FILE = 'qa-note.txt';
const PLANT_TEXT =
  `Use the Read tool to read ${NONCE_FILE} in the current directory, then remember ` +
  'the secret word it contains. Reply with only the word OK.';
/**
 * Asks only about PRESENT possession -- no route, no history, no claim that
 * the word was ever in the conversation.
 *
 * The earlier wording ("the secret word I told you earlier in this
 * conversation ... UNKNOWN if I never told you one") presupposed both. It was
 * accurate while the nonce was planted in the message text, and became false
 * when the planting turn was routed through a tool: the user never tells the
 * model anything now, a file does. A literal `UNKNOWN` was then correct for
 * the wrong reason, and could not be told apart from the model genuinely no
 * longer having the word.
 */
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

/**
 * Whether a pid is a RUNNING process — deliberately not "whether the pid
 * exists".
 *
 * A zombie has already died and released its memory; it lingers only as an
 * exit-status entry until its parent reaps it. But it keeps a `/proc/<pid>`
 * directory and still answers `kill(pid, 0)`, so both of the obvious liveness
 * checks report it as alive.
 *
 * That matters in opposite directions for this script's two uses, and one of
 * them is unsafe. Asserting the subject's child is GONE, a zombie-blind check
 * merely waits longer than it needs to — conservative. Asserting the negative
 * control is STILL ALIVE, a zombie-blind check would pass on a process that
 * had already died, making the control vacuous while it reported success.
 * Reading the state field is what separates the two.
 */
function pidAlive(pid: number): boolean {
  const res = Bun.spawnSync(['cat', `/proc/${pid}/stat`]);
  if (res.exitCode !== 0) return false;
  const stat = new TextDecoder().decode(res.stdout);
  // `comm` is parenthesised and may itself contain spaces or parens, so the
  // state field is located from the LAST ')' rather than by splitting.
  const close = stat.lastIndexOf(')');
  if (close === -1) return false;
  const state = stat.slice(close + 1).trim().charAt(0);
  // Z = zombie (dead, unreaped), X = dead. Everything else is a real process.
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

/**
 * The `claude` descendant of a worker's harness process, if it is running.
 * The tree is `sh -c 'bun <entry>'` -> bun (harness) -> claude; the harness is
 * what the server holds, and the `claude` child is the ~74% of the footprint
 * eviction exists to reclaim, so its liveness is asserted separately from the
 * harness's rather than inferred from it.
 */
function claudeDescendantPids(harnessPid: number): number[] {
  const found: number[] = [];
  for (const pid of descendantPids(harnessPid)) {
    // `pgrep` lists zombies, and a zombie still has a readable `comm`. Filter
    // through the state-aware check so a "still alive" control cannot be
    // satisfied by a process that has already died — see `pidAlive`.
    if (!pidAlive(pid)) continue;
    let comm = '';
    try {
      comm = new TextDecoder()
        .decode(Bun.spawnSync(['cat', `/proc/${pid}/comm`]).stdout)
        .trim();
    } catch {
      continue;
    }
    if (comm.includes('claude')) found.push(pid);
  }
  return found;
}

async function main(): Promise<void> {
  // Moved into main() (Issue #1479 follow-up: CodeRabbit + a self-sweep
  // both found this class of gap in the "pure wrap" files) -- these three
  // statements ran unconditionally on import: `parseIdleMs()` can
  // `process.exit(2)` on a bad `--idle-ms`, the env write and `chdir`
  // mutated the importer's process state even on success.
  const idleMs = parseIdleMs();
  process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS = String(idleMs);

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
    console.log(`==> idle threshold for this run: ${idleMs} ms`);
    console.log(`==> nonce: ${NONCE}`);

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    // Observe the global worker-exit callback -- the same seam
    // websocket/routes.ts registers its notification suppression on. This
    // records what the server would have handed that suppression, which is
    // the value the assertion below is about.
    const observedExits: Array<{ workerId: string; reason: string }> = [];
    ctx.sessionManager.setGlobalWorkerExitCallback((_sessionId, workerId, _code, reason) => {
      observedExits.push({ workerId, reason });
    });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-eviction-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    realCwd = path.join(os.tmpdir(), `ac-eviction-smoke-cwd-${crypto.randomUUID()}`);
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

    // --- Two sessions, one `claude-sdk` worker each. Separate sessions rather
    // than two workers in one, so the control worker's CONVERSATION cannot
    // share anything with the subject's by construction.
    //
    // Their FILESYSTEM is shared: both are created on `realCwd`. That is why
    // the nonce file is deleted once the planting turn has read it -- while it
    // existed, B could have answered from the file rather than from ignorance,
    // and A could have answered from the file rather than from the resume.
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

    // --- Subject A: activate, plant the nonce.
    console.log('==> subject A: activate + plant nonce');
    const a = await makeWorker('A');
    await ctx.sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
    const aHarness = harnessPid(a.sessionId, a.workerId);
    if (aHarness === null) throw new Error('A has no subprocess after activation');
    // Marker taken before the turn so the assertion below reads only this
    // turn's events. `runTurn` computes its own internal slice and returns
    // text, so the stream is re-read here rather than threading a second
    // return value through every call site.
    const plantMarker = (await readEvents(a.sessionId, a.workerId)).length;
    const plantReply = await runTurn(a.sessionId, a.workerId, PLANT_TEXT);
    // Asserted, not intended: instructing the model to read a file does not
    // make it do so. If it answers from the message text the exchange is
    // text-only again, and this smoke would keep passing while no longer
    // exercising the event order a tool-using turn writes -- a rule satisfied
    // on paper and broken in fact, which is the shape the requirement exists
    // to prevent. The `tool-call` event is in the persisted stream.
    const plantEvents = (await readEvents(a.sessionId, a.workerId)).slice(plantMarker);
    expect(
      plantEvents.some((e) => e.type === 'tool-call'),
      'the planting turn actually called a tool',
      `events after the plant: ${plantEvents.map((e) => e.type).join(',')}`,
    );

    // The nonce now exists in TWO places: A's conversation, and the file. Only
    // the first is under test, so the second is removed the moment the planting
    // turn has used it.
    //
    // Left in place, the recall below has a second route to green -- the woken
    // worker reads the file again and answers correctly while the conversation
    // did NOT survive. That would prove the filesystem survived, which was
    // never in question, under a label claiming the conversation did. The file
    // arrived together with the tool-using-turn requirement, so this route
    // arrived with it too.
    unlinkSync(path.join(realCwd!, NONCE_FILE));
    console.log(`  A harness pid: ${aHarness}`);
    console.log(`  A plant reply: ${plantReply.trim().slice(0, 120)}`);
    const aClaudeBefore = claudeDescendantPids(aHarness);
    console.log(`  A claude descendants: ${JSON.stringify(aClaudeBefore)}`);
    expect(
      aClaudeBefore.length > 0,
      'A has a live `claude` descendant before eviction',
      'without one there is nothing for eviction to reclaim and the positive assertion below would be vacuous',
    );

    const aWorkerBefore = ctx.sessionManager.getWorker(a.sessionId, a.workerId);
    const aSdkSessionIdBefore =
      (aWorkerBefore as { sdkSessionId?: string | null } | undefined)?.sdkSessionId ?? null;
    console.log(`  A sdkSessionId before: ${aSdkSessionIdBefore}`);
    expect(
      typeof aSdkSessionIdBefore === 'string' && aSdkSessionIdBefore.length > 0,
      'A persisted an SDK session id before eviction',
      'the resume the wake performs is keyed on this id; without it the wake could only start fresh',
    );

    // --- Control B: activated LATER, so it is still inside its own countdown
    // at the moment A's elapses. This staggering is the whole negative control.
    console.log('==> control B: activate + one turn (never hears the nonce)');
    const b = await makeWorker('B');
    await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
    const bHarness = harnessPid(b.sessionId, b.workerId);
    if (bHarness === null) throw new Error('B has no subprocess after activation');
    await runTurn(b.sessionId, b.workerId, 'Reply with only the word READY.');
    console.log(`  B harness pid: ${bHarness}`);

    // --- Wait for A's eviction.
    console.log('==> waiting for A to be evicted');
    const evictionDeadline = Date.now() + idleMs + 60_000;
    let aEvicted = false;
    while (Date.now() < evictionDeadline) {
      if (harnessPid(a.sessionId, a.workerId) === null) {
        aEvicted = true;
        break;
      }
      await delay(500);
    }
    expect(aEvicted, 'A was evicted within its idle threshold', `waited up to ${idleMs + 60_000} ms`);
    if (!aEvicted) throw new Error('A was never evicted; the remaining assertions would be meaningless');

    // --- BOTH POLARITIES, AT THE SAME INSTANT. -------------------------------
    const aHarnessAlive = pidAlive(aHarness);
    const aClaudeStillAlive = aClaudeBefore.filter((pid) => pidAlive(pid));
    const bHarnessAlive = pidAlive(bHarness);
    const bClaudeNow = claudeDescendantPids(bHarness);

    // The negative control's measured reach, stated so it is not over-read.
    //
    // It discriminates "A was evicted" from "everything is being killed at
    // once" -- that is the hypothesis it was built for, and it covers it.
    //
    // It does NOT discriminate "the engine gate was removed", because B's
    // countdown starts at ITS last activity, which is later than A's. Under a
    // mutation that makes every engine evictable, B is still inside its own
    // window at the instant A's elapses, and every assertion below still
    // passes. That property is pinned in the unit layer instead, by the test
    // asserting an openai-api worker idle past the same threshold is not
    // evicted -- and removing the engine gate is what fails it there.
    console.log('==> polarity check (same instant)');
    expect(!aHarnessAlive, 'A: harness process is gone from /proc', `pid ${aHarness}`);
    expect(
      bHarnessAlive,
      'B (negative control): harness process is still alive',
      `pid ${bHarness} -- if this fails, A being gone proves nothing about eviction being selective`,
    );
    expect(
      bClaudeNow.length > 0,
      'B (negative control): `claude` descendant is still alive',
      `found: ${JSON.stringify(bClaudeNow)}`,
    );
    expect(
      harnessPid(b.sessionId, b.workerId) !== null,
      'B (negative control): the server still holds a live subprocess for it',
    );

    // --- The `claude` child's death is asserted with a bounded settle window,
    // and the latency is MEASURED rather than assumed away.
    //
    // The harness's exit is what the server observes, and the `claude`
    // grandchild does not necessarily die in the same instant. A first run of
    // this script asserted "gone" at the moment the harness's exit was
    // observed and failed -- the child was still winding down. That is a
    // meaningful distinction, not a nuisance: if the child NEVER died, the
    // feature would reclaim the harness's ~26% and leave the ~74% it exists
    // to reclaim running, and every assertion above would still pass. So the
    // window is bounded and the observed latency is printed, because that
    // latency IS the answer to "how quickly is the memory actually back".
    const settleDeadline = Date.now() + 20_000;
    const settleStart = Date.now();
    let survivors = aClaudeBefore.filter((pid) => pidAlive(pid));
    while (survivors.length > 0 && Date.now() < settleDeadline) {
      await delay(250);
      survivors = survivors.filter((pid) => pidAlive(pid));
    }
    const settleMs = Date.now() - settleStart;
    console.log(`  A claude-descendant settle latency: ${settleMs} ms`);
    expect(
      survivors.length === 0,
      `A: every \`claude\` descendant is gone from /proc (settled in ${settleMs} ms)`,
      `still alive after 20 s: ${JSON.stringify(survivors)} -- this would mean eviction reclaims the harness but NOT the child, which is ~74% of the tree`,
    );

    // --- The exit was observed, and classified as an eviction.
    const aEvents = await readEvents(a.sessionId, a.workerId);
    const aExitedRows = aEvents.filter((e) => e.type === 'exited');
    expect(aExitedRows.length === 1, 'A: exactly one `exited` row was appended', `got ${aExitedRows.length}`);
    expect(
      aExitedRows.at(-1)?.reason === 'evicted',
      "A: the `exited` row is stamped reason: 'evicted'",
      `got ${JSON.stringify(aExitedRows.at(-1))}`,
    );
    // The exit code is what distinguishes "went through the graceful shutdown
    // protocol" from "was signalled", and it is asserted because a mutation
    // measurement showed the rest of this script cannot tell them apart.
    //
    // Replacing the `deactivate` call with a direct SIGKILL of the harness --
    // an eviction that invents its own kill instead of routing through the
    // path the exit observer covers -- passed all twenty other assertions.
    // The child still died (it loses its stdio pipes when the harness goes),
    // the observer still fired, and `reason` was still 'evicted'. The only
    // observables that moved were the settle latency, 1 ms -> 253 ms, and
    // this: 0 from the shutdown protocol versus a signal-derived code.
    //
    // The latency is the more dramatic signal but the worse assertion -- a
    // timing bound tight enough to separate them invites flake. The exit code
    // separates them deterministically.
    expect(
      aExitedRows.at(-1)?.code === 0,
      'A: the eviction exited through the graceful shutdown protocol (code 0), not a signal',
      `got code ${JSON.stringify(aExitedRows.at(-1)?.code)} -- a signal-derived code means the eviction bypassed \`deactivate\``,
    );
    const bEvents = await readEvents(b.sessionId, b.workerId);
    expect(
      bEvents.filter((e) => e.type === 'exited').length === 0,
      'B (negative control): no `exited` row at all',
    );

    const aObserved = observedExits.filter((e) => e.workerId === a.workerId);
    expect(
      aObserved.length === 1 && aObserved[0].reason === 'evicted',
      "A: the global worker-exit callback observed reason: 'evicted'",
      `got ${JSON.stringify(aObserved)} -- this is the exact value websocket/routes.ts suppresses its notification on`,
    );
    expect(
      observedExits.every((e) => e.workerId !== b.workerId),
      'B (negative control): no exit was observed for it',
    );

    // --- Persistence: the state the wake reads is the state a restarted
    // server would read, because the in-memory runtime is gone.
    const aWorkerAfter = ctx.sessionManager.getWorker(a.sessionId, a.workerId);
    const aSdkSessionIdAfter =
      (aWorkerAfter as { sdkSessionId?: string | null } | undefined)?.sdkSessionId ?? null;
    expect(
      aSdkSessionIdAfter === aSdkSessionIdBefore,
      'A: the SDK session id survived the eviction unchanged',
      `before=${aSdkSessionIdBefore} after=${aSdkSessionIdAfter}`,
    );
    expect(
      aWorkerAfter !== undefined,
      'A: the worker is still logically alive (present in the session) after eviction',
    );

    // --- The wake, through the shipping delivery path.
    console.log('==> waking A with a message (the delivery choke point does the wake)');
    const recallMarker = (await readEvents(a.sessionId, a.workerId)).length;
    const recallReply = await runTurn(a.sessionId, a.workerId, RECALL_TEXT);
    console.log(`  A recall reply: ${recallReply.trim().slice(0, 200)}`);
    expect(
      harnessPid(a.sessionId, a.workerId) !== null,
      'A: a message woke it -- it has a live subprocess again',
    );
    expect(
      recallReply.includes(NONCE),
      'A: the woken worker recalled the nonce planted before the eviction',
      `expected ${NONCE} in: ${recallReply.trim().slice(0, 300)}`,
    );
    // Deleting the file closes the route; this measures that it stayed closed.
    // Without it, a later change that leaves the file behind reopens the hole
    // silently, and the assertion above keeps passing for the wrong reason.
    const recallEvents = (await readEvents(a.sessionId, a.workerId)).slice(recallMarker);
    expect(
      !recallEvents.some((e) => e.type === 'tool-call'),
      'A: the recall came from the conversation, not from a tool reading the file back',
      `events: ${recallEvents.map((e) => e.type).join(',')}`,
    );

    const restoreInfo = ctx.sessionManager.getEmbeddedAgentRestoreInfo(a.sessionId, a.workerId);
    console.log(`  A restore-info: ${JSON.stringify(restoreInfo)}`);
    expect(
      restoreInfo?.sdkResumed === true,
      'A: the woken incarnation reports sdkResumed === true',
      `got ${JSON.stringify(restoreInfo)}`,
    );
    const aSdkSessionIdWoken =
      (ctx.sessionManager.getWorker(a.sessionId, a.workerId) as
        | { sdkSessionId?: string | null }
        | undefined)?.sdkSessionId ?? null;
    expect(
      aSdkSessionIdWoken === aSdkSessionIdBefore,
      'A: the woken worker is on the SAME SDK session id, not a fresh one',
      `before=${aSdkSessionIdBefore} woken=${aSdkSessionIdWoken}`,
    );

    // --- Recall control: B never heard the nonce and must not produce it.
    // This is what makes A's recall attributable to resume rather than to the
    // question being guessable.
    console.log('==> recall control: asking B the same question');
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
