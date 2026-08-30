#!/usr/bin/env bun
/**
 * Live measurement probe for Issue #1350 (R3): does a REAL `openai-api`
 * compaction boundary retain conversation-local identifiers that were stated
 * as ORDINARY FACTS, with NO preservation coaching, before the boundary
 * fired? Measurement only -- this script never changes production behavior
 * and is not wired into CI (manual gate; see the `test-trigger.md` section
 * this script's own header asks a reader to register alongside it).
 *
 * WHY `openai-api`, NOT `claude-sdk`. `DEFAULT_COMPACTION_PROMPT` /
 * `loadCompactionPrompt()` (`packages/embedded-agent/src/compaction-prompt.ts`)
 * is wired into `AgentLoop`'s `deps.loadCompactionPrompt`, and `AgentLoop` is
 * only constructed inside `main.ts`'s `if (init.engine === 'openai-api')`
 * branch. `claude-sdk` compaction goes through the SDK's own machinery
 * (`sdk-engine.ts`) and never reads this prompt at all. So the harness here
 * is the real-provider `openai-api` E2E shape (`AppContext` + real `/mcp` +
 * `SessionManager`), NOT `probe-sdk-session-harness.ts`'s `ProbeSession`
 * (that harness spawns the Claude Code CLI via
 * `@anthropic-ai/claude-agent-sdk` and is specific to the OTHER engine --
 * importing it here would drag in an unrelated SDK dependency for a prompt
 * it never reads). `scripts/smoke/check-restore-boundary-usage-seed.ts` is
 * this script's actual sibling: same engine, same disposable
 * `AppContext`/`/mcp` harness, same `sendEmbeddedAgentUserMessage` /
 * `getWorkerOutputHistory` production entry points.
 *
 * WHAT IS BORROWED FROM `probe-sdk-compaction.ts`, AND WHAT IS NOT (per
 * Architect ruling on Issue #1350, 2026-08-30). Only the PRESSURE-ROUND
 * LOOP SHAPE is borrowed: `probe-sdk-compaction.ts`'s `drive()` (around its
 * `while (s.compactBoundaries.length === 0) { ... }` loop) pushes filler
 * content round by round until a real boundary fires, capped by a round
 * count so a mis-calibration cannot spin forever. That SHAPE -- "loop until
 * a boundary actually fired, not until a target number is reached" -- is
 * reproduced below via `runPressureLoop()`. Everything else is new for this
 * engine and this Issue:
 *   - the harness (real `AppContext`/`/mcp`, not `ProbeSession`);
 *   - the plant turn's wording, which is deliberately UNCOACHED -- it states
 *     three conversation-local identifiers as plain facts inside a task
 *     narrative, with NO "remember this", NO "must be preserved verbatim".
 *     `probe-sdk-compaction.ts`'s own plant turn ("Both facts must be
 *     preserved verbatim through any later summarisation...") is the
 *     ALREADY-KNOWN-TO-WORK coached condition and is explicitly NOT reused
 *     here -- reusing it would measure the wrong thing (PR #1349's finding,
 *     which is what opened Issue #1350 in the first place);
 *   - the post-boundary retention read (next paragraph).
 *
 * HOW RETENTION IS READ, AND WHY THIS IS MORE DIRECT THAN A RECALL TURN.
 * `openai-api`'s `context-compacted` event ALWAYS carries a `summary` field
 * (see `packages/shared/src/types/embedded-agent.ts`'s comment: "openai-api
 * always has one (it authored the distillation)"). That field is the actual
 * distillation TEXT the model produced and the server persisted -- reading
 * it directly is strictly more direct than a follow-up recall turn, which
 * would ask the ALREADY-COMPACTED model "what do you remember", introducing
 * a second, independent source of noise (the model may confabulate a
 * plausible-sounding answer that is not actually backed by what survived
 * into its own context). Reading the persisted `summary` field measures
 * exactly what Issue #1350 is about: what the distillation ITSELF contains.
 *
 * THE `--prompt-file` OVERRIDE MECHANISM, AND WHY IT IS THE PRODUCTION PATH,
 * NOT A PARALLEL ONE. `loadCompactionPrompt()`'s Layer 1 (repo) reads
 * `<cwd>/.agent-console/compaction-prompt.md`, where `cwd` is the worker's
 * `session.locationPath` (`embedded-agent-worker-service.ts` passes
 * `cwd: session.locationPath` into the `init` command). This script creates
 * every session with the SAME disposable `workCwd`, and when `--prompt-file`
 * is given, copies that file's bytes to
 * `<workCwd>/.agent-console/compaction-prompt.md` BEFORE any session is
 * created. From that point on, every compaction in this run reads the
 * override through the exact same `loadCompactionPrompt()` call production
 * uses -- there is no test-only fork of the loader. Omitting `--prompt-file`
 * leaves that path absent, so `loadCompactionPrompt()` falls through to
 * Layer 3, the bundled `DEFAULT_COMPACTION_PROMPT` -- i.e. the PRE-arm run
 * (current shipped prompt) needs no flag at all; the POST-arm run passes
 * `--prompt-file` pointing at a temp file containing the candidate revised
 * prompt text.
 *
 * `--n <count>` repeats the same arm N times (fresh session/worker per run,
 * same disposable server and `workCwd`) and aggregates a retention RATE
 * (identifiers retained / identifiers planted, across all runs), alongside
 * enough per-run detail to audit any individual result.
 *
 * NO THRESHOLD GATE. Per Issue #1350's R3: "a post rate not better than pre
 * is a finding to report, not to hide." This script always exits 0 once
 * every requested run produced an actual MEASUREMENT (a boundary fired and
 * its summary was read) -- REGARDLESS of the retention rate, including 0%.
 * A non-zero exit means the HARNESS could not produce a measurement (a run
 * never reached a boundary within the round/time budget, a turn errored or
 * timed out, setup failed) -- a different fact from "the rate was low".
 *
 * COST GUARDRAILS, AND WHY THIS SCRIPT DOES NOT REPORT A DOLLAR FIGURE.
 * `probe-sdk-compaction.ts`'s `accountTurn`/`totalCostUsd` read the Claude
 * Agent SDK's own per-query `result.total_cost_usd` and `result.modelUsage`
 * -- fields the ANTHROPIC CLI computes from its own known pricing table.
 * An arbitrary OpenAI-compatible provider's `/v1/chat/completions` response
 * carries no such field, and this repo has no generic per-token price table
 * for third-party providers, so reusing (or reinventing) a dollar figure
 * here would be fabricated, not measured. Instead this script tracks and
 * prints, after every turn: the cumulative REAL (non-estimated)
 * `prompt_tokens` reported so far (the same `context-usage.estimated ===
 * false` reading `check-restore-boundary-usage-seed.ts` already treats as
 * this engine's authoritative usage signal) and the cumulative turn count,
 * plus an overall wall-clock `--budget-minutes` ceiling (checked once per
 * turn) as the stop-guard across the WHOLE invocation (all `--n` runs
 * combined).
 *
 * Requirements:
 *   - A provider key store resolvable for `PROVIDER_KEY_REF` (default
 *     `opencode-go`, read from the single-user dev home; override with
 *     `PROVIDER_KEY_FILE`). Billable, though cheaply -- a handful of small
 *     turns per run.
 *   - Single-user mode (`AUTH_MODE=none`), which seeds a real `users` row
 *     from the OS uid, same as its sibling smoke.
 *
 * Usage:
 *   bun scripts/smoke/probe-compaction-fidelity.ts
 *   bun scripts/smoke/probe-compaction-fidelity.ts --n 10
 *   bun scripts/smoke/probe-compaction-fidelity.ts --prompt-file /tmp/candidate-prompt.txt --n 10
 *   bun scripts/smoke/probe-compaction-fidelity.ts --budget-minutes 45
 *
 * Exit codes:
 *   0  every requested run produced a measurement (a boundary fired and its
 *      summary was read) -- the retention rate itself, however low, is a
 *      valid and complete result, never a failure
 *   1  at least one requested run did NOT produce a measurement (round cap
 *      or overall budget exceeded before a boundary fired, a turn errored
 *      or timed out) while at least one other run DID -- partial harness
 *      failure; whatever measurements were obtained are still reported
 *   2  bad usage, or the harness could not run at all (setup failure before
 *      any run could start, or every requested run failed to measure)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { McpDependencies } from '../../packages/server/src/mcp/mcp-server.ts';
import { DEFAULT_COMPACTION_THRESHOLD } from '../../packages/shared/src/types/embedded-agent.ts';
import * as os from 'node:os';
import * as path from 'node:path';

const USAGE_TEXT = `Usage: bun scripts/smoke/probe-compaction-fidelity.ts [--prompt-file <path>] [--n <count>] [--budget-minutes <n>]
  --prompt-file <path>  Override the compaction prompt for this run (POST arm). Omit for the
                         current bundled DEFAULT_COMPACTION_PROMPT (PRE arm).
  --n <count>            Repeat the arm this many times and aggregate a retention rate. Default 1.
  --budget-minutes <n>   Overall wall-clock ceiling across ALL runs combined. Default 30.`;

/**
 * Deliberately small, same value and same rationale as
 * `check-restore-boundary-usage-seed.ts`'s `WINDOW_TOKENS`: a conservative
 * declared window keeps the pressure loop cheap (a handful of turns) rather
 * than needing to grow a conversation to a real model's full window.
 */
const WINDOW_TOKENS = 12_000;
const THRESHOLD_TOKENS = DEFAULT_COMPACTION_THRESHOLD * WINDOW_TOKENS;

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

const TURN_TIMEOUT_MS = 180_000;
/** Safety valve so a mis-calibration cannot spin one run forever. */
const MAX_PRESSURE_ROUNDS = 12;
/**
 * Word count per pressure-round filler turn. Mirrors
 * `check-restore-boundary-usage-seed.ts`'s `filler(900)` sizing (~1000-1200
 * tokens/turn against this same `WINDOW_TOKENS`), which that script measured
 * converges to threshold within `MAX_PRESSURE_ROUNDS` for this window size.
 */
const FILLER_WORDS_PER_ROUND = 900;

let budgetMinutes = 30;
let promptFilePath: string | undefined;
let runCount = 1;

const startedAt = Date.now();
let cumulativeRealPromptTokens = 0;
let cumulativeTurns = 0;

function budgetExceeded(): string | null {
  const minutes = (Date.now() - startedAt) / 60_000;
  if (minutes > budgetMinutes) return `elapsed ${minutes.toFixed(1)} min > budget ${budgetMinutes} min`;
  return null;
}

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

class BailError extends Error {}
function bail(message: string): never {
  throw new BailError(message);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(150);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Word-based, not char-repeated: mirrors `check-restore-boundary-usage-seed.ts`'s
 * `filler()` and its documented rationale (a run of identical characters
 * tokenizes far denser than natural text, which would distort the pressure
 * calibration for a reason unrelated to this Issue). Not imported from that
 * script because its `filler` is not exported, and duplicating ~15 lines is
 * more honest than adding cross-script coupling this repo's manual smokes do
 * not otherwise have (the one exception, `probe-sdk-session-harness.ts`, is
 * shared only between two `claude-sdk`-specific siblings that document that
 * sharing decision explicitly -- see this file's own header above).
 */
function filler(nWords: number): string {
  const vocabulary = (
    'the quick brown fox jumps over a lazy dog while several curious badgers observe from beneath ' +
    'the old stone bridge and consider whether the afternoon light will hold long enough for them ' +
    'to finish counting every pebble in the shallow water below'
  ).split(' ');
  const words: string[] = [];
  for (let i = 0; i < nWords; i++) words.push(vocabulary[i % vocabulary.length]);
  return words.join(' ');
}

function nonce(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
}

interface PlantedIdentifiers {
  runId: string;
  filename: string;
  reference: string;
}

function makeIdentifiers(runIndex: number): PlantedIdentifiers {
  return {
    runId: nonce(`RUN${runIndex}`),
    filename: `report-${Math.random().toString(36).slice(2, 8)}.tsv`,
    reference: `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  };
}

/**
 * STOP -- before you add a "remember this" / "must be preserved verbatim"
 * line to this message, don't. That edit would silently change this script
 * from measuring Issue #1350's actual question to measuring the OTHER,
 * already-known-to-work condition -- see `probe-sdk-compaction.ts`'s plant
 * turn for what that already-answered condition looks like. Reusing a coached
 * plant turn here is precisely the mistake this investigation had to catch
 * and correct, at real cost, before this script existed (PR #1349's finding,
 * which is what opened Issue #1350). If you want to test whether coaching
 * changes the outcome, that is a different, new probe -- not an edit to this
 * one.
 *
 * Stated as ordinary facts inside a task-setup narrative -- NO "remember
 * this", NO "must be preserved verbatim". This is the Issue's own "How to
 * verify" form: "state an identifier mid-conversation without asking for it
 * to be preserved." All three identifiers are planted in a single turn
 * (rather than split across several) for turn economy; the Issue's spec does
 * not require splitting, and nothing about what is measured changes if they
 * arrive together.
 */
function plantMessage(ids: PlantedIdentifiers): string {
  return (
    `We're setting up the nightly billing export job. The output file will be named ` +
    `${ids.filename}. The finance team's change request for this job is tracked as ` +
    `${ids.reference}. The job's internal run id is ${ids.runId}. Reply with exactly the ` +
    `single word: ok`
  );
}

interface RunOutcome {
  runIndex: number;
  ids: PlantedIdentifiers;
  measured: boolean;
  reason?: string;
  roundsToFire?: number;
  preTokens?: number;
  postTokens?: number;
  summaryChars?: number;
  retained?: { runId: boolean; filename: boolean; reference: boolean };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt-file') {
      const raw = argv[++i];
      if (raw === undefined) {
        console.error(`${USAGE_TEXT}\n  --prompt-file requires a path.`);
        return 2;
      }
      promptFilePath = raw;
      continue;
    }
    if (a === '--n') {
      const raw = argv[++i];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        console.error(`${USAGE_TEXT}\n  --n requires a positive integer. Got: ${raw ?? '(nothing)'}`);
        return 2;
      }
      runCount = Number(raw);
      continue;
    }
    if (a === '--budget-minutes') {
      const raw = argv[++i];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        console.error(`${USAGE_TEXT}\n  --budget-minutes requires a positive integer. Got: ${raw ?? '(nothing)'}`);
        return 2;
      }
      budgetMinutes = Number(raw);
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    return 2;
  }

  let promptFileContent: string | undefined;
  if (promptFilePath !== undefined) {
    try {
      promptFileContent = readFileSync(promptFilePath, 'utf-8');
    } catch (err) {
      console.error(`${USAGE_TEXT}\n  could not read --prompt-file ${promptFilePath}: ${String(err)}`);
      return 2;
    }
  }

  console.log(
    `arm: ${promptFilePath ? `POST (--prompt-file ${promptFilePath})` : 'PRE (bundled DEFAULT_COMPACTION_PROMPT)'}   n=${runCount}   budget=${budgetMinutes} min`,
  );

  const disposableHome = path.join(os.tmpdir(), `agent-console-1350-fidelity-${process.pid}-${Date.now()}`);
  const workCwd = path.join(disposableHome, 'work');
  mkdirSync(workCwd, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);
  console.log(`==> shared session cwd for all runs: ${workCwd}`);

  if (promptFileContent !== undefined) {
    // The SAME repo-layer path `loadCompactionPrompt()` reads at
    // `<cwd>/.agent-console/compaction-prompt.md` -- see this file's header
    // for why this is the production path, not a parallel one.
    const overrideDir = path.join(workCwd, '.agent-console');
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(path.join(overrideDir, 'compaction-prompt.md'), promptFileContent);
    console.log(`==> wrote override prompt to ${path.join(overrideDir, 'compaction-prompt.md')} (${promptFileContent.length} chars)`);
  }

  let apiKey: string;
  try {
    const store = JSON.parse(readFileSync(PROVIDER_KEY_FILE, 'utf-8')) as Record<string, string>;
    if (typeof store[PROVIDER_KEY_REF] !== 'string') {
      bail(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
    }
    apiKey = store[PROVIDER_KEY_REF];
  } catch (err) {
    if (err instanceof BailError) throw err;
    bail(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
  }
  writeFileSync(path.join(disposableHome, 'provider-keys.json'), JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }), {
    mode: 0o600,
  });

  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'none';
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  const { createAppContext, shutdownAppContext } = await import('../../packages/server/src/app-context.ts');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.ts');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.ts'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.ts');

  const ctx = await createAppContext({ broadcastToApp: () => {} });

  const mcpDeps: McpDependencies = {
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
    broadcastToApp: () => {},
    fetchPullRequestUrl: ctx.fetchPullRequestUrl,
    findOpenPullRequest: ctx.findOpenPullRequest,
    mcpTokenRegistry: ctx.mcpTokenRegistry,
  };
  const server = Bun.serve({ fetch: createMcpApp(mcpDeps).fetch, port, hostname: '127.0.0.1' });
  console.log(`==> real /mcp served at http://127.0.0.1:${server.port}/mcp`);

  const sm = ctx.sessionManager;

  async function readEvents(sessionId: string, workerId: string): Promise<StreamEvent[]> {
    const hist = await sm.getWorkerOutputHistory(sessionId, workerId);
    if (!hist) return [];
    const events: StreamEvent[] = [];
    for (const line of hist.data.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line) as StreamEvent);
      } catch {
        // A previous incarnation may have been killed mid-write.
      }
    }
    return events;
  }

  const outcomes: RunOutcome[] = [];

  try {
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser) bail('ctx.userMode.authenticate() returned null; single-user mode should always resolve a user');

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `compaction-fidelity-smoke-${process.pid}`,
        description: 'Disposable definition for the Issue #1350 compaction-fidelity probe.',
        provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
        contextWindowTokens: WINDOW_TOKENS,
      },
      authUser.id,
    );
    console.log(`==> definition ${definition.id} (${PROVIDER_MODEL}, W=${WINDOW_TOKENS}, threshold=${THRESHOLD_TOKENS})`);

    for (let runIndex = 1; runIndex <= runCount; runIndex++) {
      h(`Run ${runIndex}/${runCount}`);
      const exceeded = budgetExceeded();
      if (exceeded) {
        outcomes.push({ runIndex, ids: makeIdentifiers(runIndex), measured: false, reason: `budget exhausted before this run could start: ${exceeded}` });
        console.log(`  SKIPPED: ${exceeded}`);
        continue;
      }

      const ids = makeIdentifiers(runIndex);
      let sessionId = '';
      let workerId = '';
      try {
        const session = await sm.createSession({ type: 'quick', locationPath: workCwd }, { createdBy: authUser.id });
        sessionId = session.id;
        if (!session.createdBy) {
          outcomes.push({ runIndex, ids, measured: false, reason: 'created session has no createdBy; activation cannot mint an MCP identity' });
          continue;
        }

        const worker = await sm.createWorker(sessionId, { type: 'embedded-agent', embeddedAgentId: definition.id });
        if (!worker) {
          outcomes.push({ runIndex, ids, measured: false, reason: 'worker creation returned null' });
          continue;
        }
        workerId = worker.id;

        await sm.activateEmbeddedAgentWorker(sessionId, workerId);
        if (
          !(await waitFor(
            async () => (await readEvents(sessionId, workerId)).some((e) => e.type === 'ready'),
            TURN_TIMEOUT_MS,
            'the incarnation to report ready',
          ))
        ) {
          outcomes.push({ runIndex, ids, measured: false, reason: 'incarnation never reported ready' });
          continue;
        }

        // ------------------------------------------------------------
        // Plant: state the three identifiers as ordinary facts, no
        // preservation coaching.
        // ------------------------------------------------------------
        const plantMarker = (await readEvents(sessionId, workerId)).length;
        const planted = await sm.sendEmbeddedAgentUserMessage(sessionId, workerId, plantMessage(ids));
        if (!planted.ok) {
          outcomes.push({ runIndex, ids, measured: false, reason: `plant turn refused: ${JSON.stringify(planted)}` });
          continue;
        }
        const plantDone = await waitFor(
          async () =>
            (await readEvents(sessionId, workerId)).slice(plantMarker).some((e) => e.type === 'state' && e.state === 'idle'),
          TURN_TIMEOUT_MS,
          'the plant turn to complete',
        );
        cumulativeTurns += 1;
        if (!plantDone) {
          outcomes.push({ runIndex, ids, measured: false, reason: 'plant turn never completed' });
          continue;
        }
        {
          const plantEvents = (await readEvents(sessionId, workerId)).slice(plantMarker);
          const usage = plantEvents.filter((e) => e.type === 'context-usage').at(-1);
          if (usage && usage.estimated === false) cumulativeRealPromptTokens += usage.promptTokens as number;
        }
        console.log(`  planted: runId=${ids.runId} filename=${ids.filename} reference=${ids.reference}`);

        // ------------------------------------------------------------
        // Pressure loop: push filler turns until a REAL boundary fires.
        // Loop shape borrowed from probe-sdk-compaction.ts's drive() --
        // terminate on "a boundary actually fired", capped by a round count,
        // not on a target usage number.
        // ------------------------------------------------------------
        let boundary: StreamEvent | undefined;
        let round = 0;
        let stopReason: string | undefined;
        while (!boundary) {
          const budgetGone = budgetExceeded();
          if (budgetGone) {
            stopReason = `overall budget exceeded mid-run: ${budgetGone}`;
            break;
          }
          if (round >= MAX_PRESSURE_ROUNDS) {
            stopReason = `round cap (${MAX_PRESSURE_ROUNDS}) reached without a boundary`;
            break;
          }
          round++;
          const marker = (await readEvents(sessionId, workerId)).length;
          const sent = await sm.sendEmbeddedAgentUserMessage(
            sessionId,
            workerId,
            `Ledger round ${round}. Do not summarise it, just acknowledge.\n\n${filler(FILLER_WORDS_PER_ROUND)}\n\nReply with exactly the single word: ack`,
          );
          if (!sent.ok) {
            stopReason = `pressure round ${round} refused: ${JSON.stringify(sent)}`;
            break;
          }
          const done = await waitFor(
            async () =>
              (await readEvents(sessionId, workerId)).slice(marker).some((e) => e.type === 'state' && e.state === 'idle'),
            TURN_TIMEOUT_MS,
            `pressure round ${round} to complete`,
          );
          cumulativeTurns += 1;
          if (!done) {
            stopReason = `pressure round ${round} never completed`;
            break;
          }
          const roundEvents = (await readEvents(sessionId, workerId)).slice(marker);
          const usage = roundEvents.filter((e) => e.type === 'context-usage').at(-1);
          if (usage && usage.estimated === false) cumulativeRealPromptTokens += usage.promptTokens as number;
          console.log(
            `    round ${round}: ${usage ? `promptTokens=${usage.promptTokens} estimated=${usage.estimated}` : '(no context-usage this round)'}  cumulative real tokens=${cumulativeRealPromptTokens}  cumulative turns=${cumulativeTurns}`,
          );
          boundary = roundEvents.find((e) => e.type === 'context-compacted');
        }

        if (!boundary) {
          outcomes.push({ runIndex, ids, measured: false, roundsToFire: round, reason: stopReason ?? 'no boundary and no stop reason (unexpected)' });
          console.log(`  NO MEASUREMENT: ${stopReason}`);
          continue;
        }

        const summary = typeof boundary.summary === 'string' ? boundary.summary : '';
        const retained = {
          runId: summary.includes(ids.runId),
          filename: summary.includes(ids.filename),
          reference: summary.includes(ids.reference),
        };
        outcomes.push({
          runIndex,
          ids,
          measured: true,
          roundsToFire: round,
          preTokens: boundary.preTokens as number | undefined,
          postTokens: boundary.postTokens as number | undefined,
          summaryChars: summary.length,
          retained,
        });
        console.log(
          `  BOUNDARY at round ${round}: source=${String(boundary.source)} preTokens=${boundary.preTokens} postTokens=${boundary.postTokens} summaryChars=${summary.length}`,
        );
        console.log(`    retained: runId=${retained.runId} filename=${retained.filename} reference=${retained.reference}`);
        console.log(`    summary: ${JSON.stringify(summary.slice(0, 500))}`);
      } finally {
        if (sessionId && workerId) {
          try {
            await sm.deactivateEmbeddedAgentWorker(sessionId, workerId);
          } catch {
            // Best effort: the run's report must not depend on teardown.
          }
        }
      }
    }
  } finally {
    server.stop(true);
    await shutdownAppContext(ctx);
    console.log(`\n==> disposable home left at ${disposableHome} (remove with: find ${disposableHome} -depth -delete)`);
  }

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------
  h('Per-run detail');
  for (const o of outcomes) {
    if (!o.measured) {
      console.log(`  run ${o.runIndex}: NO MEASUREMENT -- ${o.reason}`);
      continue;
    }
    console.log(
      `  run ${o.runIndex}: rounds=${o.roundsToFire} preTokens=${o.preTokens} postTokens=${o.postTokens} ` +
        `summaryChars=${o.summaryChars}  runId=${o.retained?.runId} filename=${o.retained?.filename} reference=${o.retained?.reference}`,
    );
  }

  const measured = outcomes.filter((o) => o.measured);
  const unmeasured = outcomes.filter((o) => !o.measured);
  let retainedCount = 0;
  let plantedCount = 0;
  for (const o of measured) {
    plantedCount += 3;
    if (o.retained?.runId) retainedCount++;
    if (o.retained?.filename) retainedCount++;
    if (o.retained?.reference) retainedCount++;
  }

  h('Aggregate');
  console.log(`arm: ${promptFilePath ? `POST (${promptFilePath})` : 'PRE (bundled default)'}`);
  console.log(`requested runs: ${runCount}   measured: ${measured.length}   unmeasured: ${unmeasured.length}`);
  if (measured.length > 0) {
    console.log(
      `retention: ${retainedCount}/${plantedCount} identifiers retained verbatim (${((retainedCount / plantedCount) * 100).toFixed(1)}%)`,
    );
  } else {
    console.log('retention: NOT MEASURABLE -- no run reached a boundary');
  }
  if (unmeasured.length > 0) {
    console.log(`unmeasured runs (harness could not produce a boundary):`);
    for (const o of unmeasured) console.log(`  - run ${o.runIndex}: ${o.reason}`);
  }
  console.log(
    `\nelapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative turns=${cumulativeTurns}  cumulative real prompt tokens=${cumulativeRealPromptTokens}`,
  );

  if (measured.length === 0) return 2;
  if (unmeasured.length > 0) return 1;
  return 0;
}

// Guarded (Issue #1479 convention): importing this module must not fire a
// billed run as a side effect. `import.meta.main` is false for an importer,
// true only when this file is the entry point.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof BailError) {
        console.error(`==> could not run: ${err.message}`);
        process.exit(2);
      }
      console.error(err);
      process.exit(2);
    });
}
