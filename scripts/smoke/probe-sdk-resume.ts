#!/usr/bin/env bun
/**
 * Live probe for PS4 (docs/design/embedded-agent-sdk-engine.md §5): does
 * `Options.resume` actually restore a session's conversation across a
 * process kill? PS4 has been TYPED-BUT-UNPROBED since 2026-08-17 -- the
 * option's documentation says it "loads the conversation history from the
 * specified session", and this repo does not build on should-work claims.
 * §5 requires PS4 be probed before the idle-eviction phase's AC is written
 * (Issue #1336), and Issue #1400 is where that happens.
 *
 * Measurement only -- this script changes no production behavior and is not
 * wired into CI.
 *
 *   --basic        P5(a) and P5(b), the two kill shapes:
 *                  (a) kill the child while the session is IDLE between
 *                      turns, then start a new `query()` with
 *                      `resume: <sessionId>` and ask for a nonce planted
 *                      before the kill. THIS IS THE PS4 PASS CONDITION.
 *                  (b) the harsher case: kill the child MID-TURN, then
 *                      resume. Recorded either way -- a partial turn is a
 *                      legitimate thing for the SDK to drop, and what
 *                      matters is knowing which it does.
 *   --invalid      R1 (#1410): the NEGATIVE complement of --basic. What does
 *                  the SDK do when asked to resume a session id it cannot
 *                  find? Answers PS6 (a failed resume emits no `system:init`)
 *                  and PS7 (`getSessionInfo` as a pre-flight), the two
 *                  premises R1's detector and pre-flight rest on. Cheap: the
 *                  pre-flight cases spend nothing at all, and the refusal
 *                  cases die before a turn is billed.
 *   --post-compact P5(c), the eviction x compaction composite: build a
 *                  conversation, compact it with `/compact` (P2 established
 *                  that this reaches the CLI), kill, resume -- and check
 *                  whether resume lands in the POST-compact state or
 *                  replays the pre-compact conversation.
 *
 * Default (no item flag) = --basic.
 *
 * POSITIVE CONTROLS. The failure this probe must not report by accident is a
 * false negative -- "resume lost the conversation" when in truth the harness
 * never got a working session in the first place. Every negative here is
 * paired, in the same run and the same commit, with:
 *   CTRL-RESUME-PRE   the pre-kill session answering the SAME recall question
 *                     correctly before it is killed. If the nonce cannot be
 *                     recalled BEFORE the kill, nothing after the kill means
 *                     anything, and the item reports indeterminate.
 *   CTRL-RESUME-LIVE  the resumed session completing a fresh, ordinary turn.
 *                     This separates "resume produced an empty conversation"
 *                     from "the resumed process is not working at all".
 *   CTRL-RESUME-FRESH a session started WITHOUT `resume` against the same
 *                     isolated config dir, asked the same recall question.
 *                     It must answer UNKNOWN. This is what makes a
 *                     successful recall attributable to `resume` rather than
 *                     to the model, the config dir, or the prompt.
 *
 * METHODOLOGY: see `probe-sdk-session-harness.ts`'s header -- production
 * `spawnClaudeCodeProcess`/`UserMessageQueue`, a `for await` loop that never
 * breaks early (`probe-sdk-h2-transport-settle-negative-control.ts` is the
 * canonical account of why), and usage polls issued from inside that live
 * loop body. The isolated `CLAUDE_CONFIG_DIR` is load-bearing here in a way
 * it is not for the compaction probe: a resumed session is read back from
 * the SAME throwaway directory the original wrote its transcript into, so
 * the override is set once per process and never changed mid-run.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user, and `bun install` already run so
 * `@anthropic-ai/claude-agent-sdk` resolves to the version under test. This
 * makes real Anthropic API calls and costs real usage -- a manual tool, not
 * a CI gate (hence no `check:` alias).
 *
 * Usage: the invocation line is NOT restated here. `USAGE_TEXT` below is its
 * single writer -- the script prints it on any usage error, and the flag list
 * it names (`ITEM_FLAGS`) is the same constant the parser reads. This header
 * used to carry its own copy, and the two drifted: the header omitted
 * `--pressure` entirely, which is the modifier the design doc's PS4 trail
 * tells operators to reach for.
 *
 * Exit codes:
 *   0  every selected item produced a determinate result
 *   1  a STOP condition (#1400): resume errored, or returned an empty
 *      conversation, on the P5(a) idle-kill path -- PS4 FAILS, #1336 stays
 *      reserved, and the `claude-sdk` restore path needs redesigning.
 *      Consult before changing any design.
 *   2  bad usage / probe could not run (unrecognized argument, no `claude`
 *      auth, or the CLAUDE_CONFIG_DIR isolation could not be verified) --
 *      argument validation happens before anything billable runs.
 */

import { getSessionInfo, type Options } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import {
  ProbeSession,
  filler,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  transcriptFiles,
  turnLine,
  turnSettled,
  unsettledReason,
  usageLine,
  verifyIsolation,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

// ---------------------------------------------------------------------------
// Argument parsing -- BEFORE anything billable runs.
// ---------------------------------------------------------------------------

const ITEM_FLAGS = ['--basic', '--invalid', '--post-compact', '--pressure'] as const;
/** Single writer of this script's invocation line -- see the file header. */
const USAGE_TEXT = `Usage: bun scripts/smoke/probe-sdk-resume.ts [--basic] [--invalid] [--post-compact [--pressure]]
  Default (no item flag) = --basic. --pressure is a modifier for --post-compact.`;
const argv = process.argv.slice(2);
const selected = new Set<string>();
for (const a of argv) {
  if ((ITEM_FLAGS as readonly string[]).includes(a)) {
    selected.add(a);
    continue;
  }
  console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
  process.exit(2);
}
if (selected.size === 0) selected.add('--basic');
if (selected.has('--pressure') && !selected.has('--post-compact')) {
  console.error(`${USAGE_TEXT}\n  --pressure is a modifier for --post-compact and does nothing on its own.`);
  process.exit(2);
}
/** See `itemPostCompact`'s "why this modifier exists" note. Billable. */
const PRESSURE = selected.has('--pressure');

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const CONFIG_DIR = isolateClaudeConfigDir('resume');
const startedAt = Date.now();
const perSession = new Map<string, { tokens: number; cost: number }>();

/** Mirrors `sdk-engine.ts`'s `buildOptions` pins that matter here. */
function buildOptions(extra: Partial<Options> = {}): Options {
  return {
    executable: 'bun',
    cwd: process.cwd(),
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [],
    settings: { autoCompactEnabled: false },
    ...extra,
  };
}

function account(label: string, outcome: Pick<TurnOutcome, 'result'>): void {
  const r = outcome.result;
  if (!r) return;
  let prompt = 0;
  for (const mu of Object.values(r.modelUsage ?? {})) {
    prompt += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
  }
  // modelUsage/total_cost_usd are cumulative per query() call, so keep each
  // session's latest figure and sum across sessions rather than over turns.
  perSession.set(label, { tokens: prompt, cost: r.total_cost_usd ?? 0 });
}
function totals(): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const v of perSession.values()) {
    tokens += v.tokens;
    cost += v.cost;
  }
  return { tokens, cost };
}

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}   [${stamp()}]\n${'='.repeat(72)}`);
}

interface ItemVerdict {
  item: string;
  verdict: string;
  stop: boolean;
  control: string;
}
const verdicts: ItemVerdict[] = [];

const RECALL_PROMPT =
  'Two questions, answered in two short lines. Line 1: the exact token I asked you to remember earlier in this conversation, verbatim, or the word UNKNOWN if you were never given one. Line 2: in at most 15 words, what this conversation has been about, or UNKNOWN.';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * SIGKILL, not SIGTERM: the eviction case PS4 stands behind is a process
 * that goes away without a chance to flush or shut down cleanly. A graceful
 * signal would test a gentler thing than the one the premise claims.
 */
async function killChildren(s: ProbeSession, label: string): Promise<void> {
  console.log(`${label}: killing ${s.children.length} child process(es) with SIGKILL`);
  for (const c of s.children) {
    try {
      c.kill('SIGKILL');
    } catch (err) {
      console.log(`  kill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await s.waitForStreamEnd(20_000);
  console.log(`${label}: stream ended (${s.streamEnded ?? 'still open'})${s.streamError ? ` -- ${s.streamError}` : ''}`);
}

/** Starts a resumed session and reports what came back. */
interface ResumeOutcome {
  ready: string;
  resumedSessionId: string | null;
  errored: string | null;
  /**
   * A recall turn that never settled. Kept separate from `errored` and from
   * an empty recall because the three are different facts: a stalled turn is
   * not a restored-but-empty conversation, and only the latter would be a
   * PS4 failure. Collapsing them would let a harness stall be recorded as
   * the SDK losing a conversation -- the same attribution mistake the
   * post-compaction item makes when a compaction, not resume, dropped the
   * value.
   */
  timedOut: boolean;
  recallText: string;
  recalledNonce: boolean;
  usageTotalTokens?: number;
  liveTurnOk: boolean;
}

async function resumeAndAsk(label: string, sessionId: string, token: string): Promise<ResumeOutcome> {
  const r = new ProbeSession({ label, options: buildOptions({ resume: sessionId }) });
  const ready = await r.waitForReady(60_000);
  console.log(`${label}: resume(${sessionId}) ready-via=${ready}`);

  const recall = await r.runTurn(RECALL_PROMPT);
  account(label, recall);
  const usage = recall.usage;
  console.log(`${turnLine(`${label}: recall`, recall)}`);
  console.log(`${label}: observed=${JSON.stringify(recall.observed)}`);
  console.log(`${label}: reply=${JSON.stringify(recall.text.trim().slice(0, 400))}`);
  console.log(`${label}: usage=${usageLine(usage)}`);
  console.log(`${label}: session id reported by the resumed query = ${r.sessionId ?? '(none)'} (requested ${sessionId})`);

  // CTRL-RESUME-LIVE: an ordinary turn on the resumed process. If the recall
  // came back empty, this says whether the process is broken or merely
  // amnesiac.
  const live = await r.runTurn('Reply with exactly the single word: alive');
  account(label, live);
  console.log(`${turnLine(`${label}: CTRL-RESUME-LIVE fresh turn`, live)} reply=${JSON.stringify(live.text.trim().slice(0, 60))}`);

  r.close();
  await r.waitForStreamEnd();

  return {
    ready,
    resumedSessionId: r.sessionId,
    errored: recall.streamError ?? (recall.timedOut ? `recall turn timed out (ready-via=${ready})` : null),
    timedOut: recall.timedOut,
    recallText: recall.text.trim(),
    recalledNonce: recall.text.includes(token),
    usageTotalTokens: usage?.totalTokens,
    liveTurnOk: !live.timedOut && live.result !== undefined,
  };
}

/**
 * CTRL-RESUME-FRESH: the same question, asked of a session with NO resume.
 *
 * This control is load-bearing -- it is what makes a successful recall
 * attributable to `resume` rather than to the model or the config dir. A
 * control that STALLED produces the same empty answer as one that genuinely
 * said UNKNOWN, so `settled` is returned alongside and the caller must not
 * count an unsettled control as having answered.
 */
async function freshControl(label: string, token: string): Promise<{ recalled: boolean; text: string; settled: boolean }> {
  const f = new ProbeSession({ label, options: buildOptions() });
  await f.waitForReady(60_000);
  const t = await f.runTurn(RECALL_PROMPT);
  account(label, t);
  f.close();
  await f.waitForStreamEnd();
  const recalled = t.text.includes(token);
  console.log(`${turnLine(`${label}: CTRL-RESUME-FRESH (no resume)`, t)}`);
  console.log(`${label}: reply=${JSON.stringify(t.text.trim().slice(0, 200))} recalled=${recalled}`);
  return { recalled, text: t.text.trim(), settled: turnSettled(t) };
}

// ---------------------------------------------------------------------------
// P5(a): idle kill -> resume. The PS4 pass condition.
// ---------------------------------------------------------------------------

async function itemBasic(): Promise<void> {
  h('P5(a) -- kill the child while IDLE between turns, then resume');

  const token = nonce('NONCE-RESUME-A');
  const s = new ProbeSession({ label: 'p5a-origin', options: buildOptions() });
  await s.waitForReady();

  const t1 = await s.runTurn(
    `Remember this exact token: ${token}. Also remember that this conversation is about a fictional shipping ledger for the port of Kalmar. Reply with exactly the single word: ok`,
  );
  account('p5a-origin', t1);
  console.log(`${turnLine('turn 1', t1)} text=${JSON.stringify(t1.text.trim().slice(0, 80))}`);

  const t2 = await s.runTurn('Name one more fact about the port of Kalmar in at most 12 words.');
  account('p5a-origin', t2);
  console.log(`${turnLine('turn 2', t2)} text=${JSON.stringify(t2.text.trim().slice(0, 120))}`);

  // CTRL-RESUME-PRE: the same question, answered BEFORE the kill.
  const pre = await s.runTurn(RECALL_PROMPT);
  account('p5a-origin', pre);
  const preRecalled = pre.text.includes(token);
  console.log(`${turnLine('CTRL-RESUME-PRE pre-kill recall', pre)} recalled=${preRecalled} reply=${JSON.stringify(pre.text.trim().slice(0, 200))}`);
  console.log(`pre-kill usage: ${usageLine(pre.usage)}`);

  const originSessionId = s.sessionId;
  console.log(`origin session id: ${originSessionId ?? '(none)'}`);

  // The kill happens with no turn in flight -- the "idle eviction" shape.
  await sleep(1000);
  await killChildren(s, 'p5a-origin');
  console.log(`transcripts on disk after the kill: ${transcriptFiles(CONFIG_DIR).length}`);

  if (!originSessionId) {
    verdicts.push({
      item: 'P5(a) (idle kill -> resume)',
      verdict: 'STOP -- INDETERMINATE: the origin session never reported a session id, so there was nothing to resume',
      stop: true,
      control: 'CTRL-RESUME-PRE could not be evaluated',
    });
    return;
  }

  const out = await resumeAndAsk('p5a-resume', originSessionId, token);
  const fresh = await freshControl('p5a-fresh', token);

  let verdict: string;
  let stop = false;
  if (!preRecalled) {
    verdict = 'STOP -- INDETERMINATE: the origin session could not recall the nonce even BEFORE the kill, so nothing after the kill is interpretable';
    stop = true;
  } else if (out.timedOut) {
    verdict = `STOP -- INDETERMINATE: the recall turn on the resumed session never settled (${out.errored}). A stalled turn is not a lost conversation, so this says nothing about PS4 either way -- re-run before concluding anything`;
    stop = true;
  } else if (out.errored) {
    verdict = `STOP -- PS4 FAILS: resume errored (${out.errored}). #1336 stays reserved and the claude-sdk restore path needs redesigning`;
    stop = true;
  } else if (!fresh.settled) {
    verdict = `STOP -- INDETERMINATE: CTRL-RESUME-FRESH never settled, so the control that attributes a recall to \`resume\` produced no measurement. The resumed session ${out.recalledNonce ? 'did' : 'did not'} recall the nonce, but without the control that fact is not attributable`;
    stop = true;
  } else if (out.recalledNonce && !fresh.recalled) {
    verdict = `PS4 PASSES -- after a SIGKILL of the child while idle, a new query() with \`resume: ${originSessionId}\` recalled the pre-kill nonce verbatim (${JSON.stringify(out.recallText.slice(0, 160))}). The resumed query reported session id ${out.resumedSessionId ?? '(none)'}; context usage on the resumed session was ${out.usageTotalTokens ?? '?'} tokens. A no-resume session in the same config dir answered UNKNOWN, so the recall is attributable to \`resume\`, not to the model or the environment`;
  } else if (out.recalledNonce && fresh.recalled) {
    verdict = `STOP -- INDETERMINATE: the resumed session recalled the nonce, but so did CTRL-RESUME-FRESH (a session with NO resume). The recall is not attributable to \`resume\`; the isolation or the nonce design leaks`;
    stop = true;
  } else {
    verdict = `STOP -- PS4 FAILS: resume returned a conversation with no trace of the pre-kill nonce (reply ${JSON.stringify(out.recallText.slice(0, 200))}, usage ${out.usageTotalTokens ?? '?'} tokens). The resumed process itself was alive (CTRL-RESUME-LIVE: ${out.liveTurnOk}), so this is an empty/lost conversation, not a dead harness. #1336 stays reserved`;
    stop = true;
  }
  verdicts.push({
    item: 'P5(a) (idle kill -> resume) -- the PS4 gate',
    verdict,
    stop,
    control: 'CTRL-RESUME-PRE (same question answered before the kill) + CTRL-RESUME-LIVE (resumed process completes a fresh turn) + CTRL-RESUME-FRESH (no-resume session answers UNKNOWN)',
  });
}

// ---------------------------------------------------------------------------
// P5(b): mid-turn kill -> resume. The harsher case.
// ---------------------------------------------------------------------------

async function itemMidTurn(): Promise<void> {
  h('P5(b) -- kill the child MID-TURN, then resume');

  const token = nonce('NONCE-RESUME-B');
  const s = new ProbeSession({ label: 'p5b-origin', options: buildOptions() });
  await s.waitForReady();

  const t1 = await s.runTurn(
    `Remember this exact token: ${token}. Reply with exactly the single word: ok`,
  );
  account('p5b-origin', t1);
  const preRecalled = t1.result !== undefined;
  console.log(`${turnLine('turn 1 (plant)', t1)} text=${JSON.stringify(t1.text.trim().slice(0, 80))}`);

  const originSessionId = s.sessionId;
  console.log(`origin session id: ${originSessionId ?? '(none)'}`);

  // Start a long turn and DO NOT await it -- the kill lands while it is in
  // flight. The harness settles the pending turn when the stream dies, so
  // this never hangs.
  //
  // The generation has to be long enough that the kill genuinely lands
  // mid-turn. A first pass at this asked for 400 numbers and killed after
  // 6s; the turn had already returned `result: success`, so what it actually
  // measured was an idle kill wearing a mid-turn label. The guard below
  // makes that failure mode visible instead of letting it be reported as a
  // mid-turn survival.
  const inFlight = s.runTurn(
    'Write out the numbers from 1 to 3000, one per line, with no other text. Do not stop early and do not abbreviate.',
    180_000,
  );
  await sleep(5_000);
  const killedDuringTurn = s.turnInFlight;
  console.log(`a turn was still in flight at kill time: ${killedDuringTurn}`);
  await killChildren(s, 'p5b-origin');
  const interrupted = await inFlight;
  console.log(`${turnLine('mid-turn outcome', interrupted)}`);
  console.log(`  partial assistant text length: ${interrupted.text.length} chars`);

  if (!killedDuringTurn) {
    verdicts.push({
      item: 'P5(b) (mid-turn kill -> resume)',
      verdict:
        'RECORDED NON-RESULT -- the long turn had already completed by the time the kill fired, so this run measured an idle kill, not a mid-turn one. Lengthen the generation or shorten the delay and re-run; do NOT read the P5(a) result as covering this case',
      stop: false,
      control: 'n/a -- the case under test never occurred',
    });
    return;
  }

  if (!originSessionId) {
    verdicts.push({
      item: 'P5(b) (mid-turn kill -> resume)',
      verdict: 'RECORDED NON-RESULT -- the origin session never reported a session id, so there was nothing to resume',
      stop: false,
      control: 'n/a',
    });
    return;
  }

  const out = await resumeAndAsk('p5b-resume', originSessionId, token);

  const verdict = out.errored
    ? `resume ERRORED after a mid-turn kill: ${out.errored}. Recorded as behavior, not as a PS4 STOP -- #1400 asks only that this case be recorded either way`
    : out.recalledNonce
      ? `resume SURVIVED a mid-turn kill -- the pre-kill nonce came back verbatim (${JSON.stringify(out.recallText.slice(0, 160))}); resumed session id ${out.resumedSessionId ?? '(none)'}, usage ${out.usageTotalTokens ?? '?'} tokens. The interrupted turn itself produced ${interrupted.text.length} chars before the kill`
      : `resume did NOT recover the pre-kill nonce after a mid-turn kill (reply ${JSON.stringify(out.recallText.slice(0, 200))}); the resumed process was alive (CTRL-RESUME-LIVE: ${out.liveTurnOk}). Recorded as behavior: a turn killed in flight is a legitimate thing for the SDK to drop, and P5(a) is the gate`;

  verdicts.push({
    item: 'P5(b) (mid-turn kill -> resume)',
    verdict,
    stop: false,
    control: `the plant turn completing before the kill (${preRecalled}) + CTRL-RESUME-LIVE (resumed process completes a fresh turn)`,
  });
}

// ---------------------------------------------------------------------------
// P5(c): compaction, then kill, then resume.
// ---------------------------------------------------------------------------

const WARMUP_TURNS = 5;

async function itemPostCompact(): Promise<void> {
  h('P5(c) -- compact, then kill, then resume: does resume land in the POST-compact state?');

  const token = nonce('NONCE-RESUME-C');
  const s = new ProbeSession({ label: 'p5c-origin', options: buildOptions() });
  await s.waitForReady();
  const freshBaseline = (await s.readUsage()).totalTokens;
  console.log(`fresh-session baseline (system prompt + tools, no conversation): ${freshBaseline} tokens`);

  const t1 = await s.runTurn(
    `Remember this exact token: ${token}. Also remember that this conversation is about a fictional shipping ledger for the port of Kalmar. Both facts must be preserved verbatim through any later summarisation. Reply with exactly the single word: ok`,
  );
  account('p5c-origin', t1);
  console.log(`${turnLine('plant turn', t1)}`);

  for (let i = 1; i <= WARMUP_TURNS; i++) {
    const w = await s.runTurn(`Warm-up ${i}: name one fact about the port of Kalmar in at most 12 words.`);
    account('p5c-origin', w);
    console.log(`  ${turnLine(`warm-up ${i}`, w)} text=${JSON.stringify(w.text.trim().slice(0, 80))}`);
  }

  if (PRESSURE) {
    // WHY THIS MODIFIER EXISTS. P5(c)'s question is not "did resume work"
    // (P5(a) settles that) but "WHICH STATE did resume land in". The only
    // observable that answers it is the resumed session's context usage --
    // and in a SMALL conversation that observable has almost no resolution:
    // `getContextUsage().totalTokens` is dominated by the ~21k system-prompt
    // and tool baseline, so a compaction that takes the conversation from
    // 25k to 2k moves the total by a couple of hundred tokens. The first run
    // of this item measured exactly that and could not discriminate. This
    // modifier inflates the conversation first so pre- and post-compact
    // totals are far apart and the answer is unambiguous. It costs real
    // money -- roughly one large turn plus one compaction -- which is why it
    // is opt-in rather than the default.
    const bulk = await s.runTurn(
      `Kalmar ledger bulk load. Do not summarise it, do not comment on it, just acknowledge.\n\n${filler(170_000)}\n\nReply with exactly the single word: ack`,
    );
    account('p5c-origin', bulk);
    console.log(`  ${turnLine('bulk load', bulk)} ${usageLine(bulk.usage)}`);
  }

  const beforeCompact = await s.readUsage();
  console.log(`usage before /compact: ${usageLine(beforeCompact)}`);
  const compact = await s.runTurn('/compact');
  account('p5c-origin', compact);
  console.log(`${turnLine('/compact turn', compact)} boundaries=${s.compactBoundaries.length} observed=${JSON.stringify(compact.observed)}`);
  for (const b of s.compactBoundaries) {
    console.log(
      `  compact_boundary trigger=${b.compact_metadata.trigger} pre_tokens=${b.compact_metadata.pre_tokens} post_tokens=${b.compact_metadata.post_tokens ?? '(absent)'} preserved_messages=${b.compact_metadata.preserved_messages ? b.compact_metadata.preserved_messages.uuids.length : '(none)'}`,
    );
  }
  const afterCompact = await s.readUsage();
  console.log(`usage after /compact: ${usageLine(afterCompact)}`);

  // CTRL-RESUME-PRE, taken after the compaction so it describes the state
  // resume is expected to land in.
  const pre = await s.runTurn(RECALL_PROMPT);
  account('p5c-origin', pre);
  const preRecalled = pre.text.includes(token);
  const preRecall = pre.text.trim();
  // A pre-kill recall that never settled looks exactly like one that answered
  // "I don't remember" -- and the latter is what this probe reports as a
  // COMPACTION FIDELITY loss, an observation that feeds the design doc's
  // shipping input. An unsettled turn must never be able to manufacture one.
  const preUnsettled = unsettledReason(pre, 'the post-compaction pre-kill recall');
  console.log(`${turnLine('CTRL-RESUME-PRE post-compact, pre-kill recall', pre)}`);
  console.log(`CTRL-RESUME-PRE: recalled=${preRecalled} reply=${JSON.stringify(preRecall.slice(0, 200))}`);
  if (preUnsettled) console.log(`CTRL-RESUME-PRE: NO MEASUREMENT -- ${preUnsettled}`);

  const originSessionId = s.sessionId;
  const boundaries = s.compactBoundaries.length;
  await sleep(1000);
  await killChildren(s, 'p5c-origin');

  if (!originSessionId) {
    verdicts.push({
      item: 'P5(c) (compaction x eviction composite)',
      verdict: 'RECORDED NON-RESULT -- the origin session never reported a session id',
      stop: false,
      control: 'n/a',
    });
    return;
  }

  const out = await resumeAndAsk('p5c-resume', originSessionId, token);
  const fresh = await freshControl('p5c-fresh', token);

  // Which state resume landed in is read off context usage -- but only when
  // the two candidate states are far enough apart for the reading to mean
  // anything. `compact_metadata.pre_tokens` tracks the full pre-compaction
  // context while `post_tokens` counts only the summary, so the post-compact
  // expectation has to add the fresh-session baseline back in.
  const boundary = s.compactBoundaries[0]?.compact_metadata;
  const expectedPre = boundary?.pre_tokens ?? beforeCompact.totalTokens;
  const expectedPost =
    boundary?.post_tokens === undefined ? afterCompact.totalTokens : freshBaseline + boundary.post_tokens;
  const separation = Math.abs(expectedPre - expectedPost);
  // The recall turn on the resumed session adds its own tokens, so anything
  // under a few thousand tokens of separation cannot be read confidently.
  const DISCRIMINATION_FLOOR = 5_000;
  const discriminable = separation >= DISCRIMINATION_FLOOR;
  const landedPostCompact =
    !discriminable || out.usageTotalTokens === undefined
      ? null
      : Math.abs(out.usageTotalTokens - expectedPost) < Math.abs(out.usageTotalTokens - expectedPre);
  console.log(
    `state discriminator: expectedPre=${expectedPre} expectedPost=${expectedPost} separation=${separation} (floor ${DISCRIMINATION_FLOOR}) -> ${discriminable ? 'usable' : 'UNDER-POWERED'}; resumed usage=${out.usageTotalTokens ?? '?'}`,
  );

  // When the ORIGIN session had already lost the nonce before the kill, the
  // nonce says nothing about resume -- it says the compaction dropped it.
  // Conflating the two would blame resume for a fidelity failure that
  // happened while the process was still alive, so the two are reported
  // separately and the nonce comparison is voided rather than read.
  // Three states, not two: the nonce test is valid only when the pre-kill
  // control actually answered AND remembered.
  const nonceTestValid = preRecalled && !preUnsettled;
  const stateSentence = `Which state it landed in: ${
            landedPostCompact === null
              ? `NOT DISCRIMINABLE in this run -- the pre- and post-compaction context sizes are only ${separation} tokens apart (expectedPre=${expectedPre}, expectedPost=${expectedPost}), below the ${DISCRIMINATION_FLOOR}-token floor this reading needs, because at this conversation size the ~${freshBaseline}-token system/tool baseline dominates the total. Re-run with --pressure for a discriminating measurement`
              : landedPostCompact
                ? `the POST-compact state (resumed usage ${out.usageTotalTokens}, expectedPost ${expectedPost} vs expectedPre ${expectedPre})`
                : `the PRE-compact state (resumed usage ${out.usageTotalTokens}, expectedPre ${expectedPre} vs expectedPost ${expectedPost})`
          }`;

  const verdict =
    boundaries === 0
      ? `NON-RESULT -- no compaction occurred in the origin session, so the composite was never set up. Resume itself behaved as: nonce recalled=${out.recalledNonce}, usage ${out.usageTotalTokens ?? '?'}`
      : out.timedOut
        ? `NO MEASUREMENT -- the recall turn on the resumed session never settled (${out.errored}). A stalled turn is not an errored resume and not a lost conversation`
        : out.errored
          ? `resume ERRORED on a post-compaction session: ${out.errored}`
          : preUnsettled
            ? `NONCE TEST VOID FOR LACK OF A CONTROL, STATE ANSWER VALID -- ${preUnsettled}, so it cannot be told apart from a compaction that dropped the nonce; NO fidelity claim is made from this run. ${stateSentence}`
            : nonceTestValid
              ? `resume ${out.recalledNonce ? 'RECOVERED' : 'did NOT recover'} the pre-compaction nonce from a compacted-then-killed session (reply ${JSON.stringify(out.recallText.slice(0, 200))}; a no-resume control answered UNKNOWN: ${!fresh.recalled}). ${stateSentence}`
              : `NONCE TEST VOID, STATE ANSWER VALID -- the ORIGIN session could no longer recall the nonce BEFORE the kill (it answered ${JSON.stringify(preRecall.slice(0, 80))}), so the compaction itself dropped it and the nonce cannot measure resume. Separately recorded as a COMPACTION FIDELITY observation: a ${beforeCompact.totalTokens}-token conversation was summarised to ${boundary?.post_tokens ?? '?'} tokens and lost a value the prompt explicitly asked to preserve verbatim. What resume DID do is still measurable and unambiguous here: ${stateSentence}, and the resumed session reproduced the origin's own post-compaction answer (${JSON.stringify(out.recallText.slice(0, 80))}) rather than a fresh-session one -- a no-resume control answered UNKNOWN with a visibly different explanation: ${!fresh.recalled}`;

  verdicts.push({
    item: 'P5(c) (compaction x eviction composite)',
    verdict,
    stop: false,
    control: 'CTRL-RESUME-PRE (post-compact recall before the kill) + CTRL-RESUME-LIVE + CTRL-RESUME-FRESH (no-resume session answers UNKNOWN)',
  });
}

// ---------------------------------------------------------------------------
// R1 (#1410): what an INVALID resume does -- PS6 and PS7
// ---------------------------------------------------------------------------

/**
 * The negative complement of `--basic`. `--basic` establishes that a VALID
 * resume works; on its own that says nothing about how an invalid one fails,
 * and R1's whole failure design turns on the answer.
 *
 * Two premises, measured in one run:
 *
 * - **PS6 -- a failed resume emits no `system:init`.** This is what R1's
 *   detector keys on, and it has to be structural: the result subtype is
 *   `error_during_execution`, which an ordinary `interrupt()` also produces,
 *   and the SDK's error wording is undocumented CLI text. What separates a
 *   cancel from a refused resume is that a cancel always has a `system:init`
 *   behind it and a refused resume never does. If this premise breaks, the
 *   detector reports every failed resume as a SUCCESS -- it fails toward
 *   silence, which is why it is worth a probe rather than an assumption.
 * - **PS7 -- `getSessionInfo` does not report `undefined` for a live
 *   session.** R1 pre-flights the id with it before constructing, which moves
 *   the failure off the user's first message. The SDK's own contract allows
 *   `undefined` for a session with "no extractable summary", and a false
 *   `undefined` would make the pre-flight throw away a resumable
 *   conversation -- the one way the pre-flight could be worse than not
 *   having it. So the positive case here is not an easy sample: it is the
 *   worst shape production creates, a session killed during its FIRST turn
 *   with no assistant reply ever produced.
 *
 * `--basic`'s controls are inherited by construction: this item creates its
 * own live session first and confirms the harness works before drawing any
 * conclusion from a negative.
 */
async function itemInvalidResume(): Promise<void> {
  h('R1 -- resume an id the SDK cannot find (PS6), and pre-flight it (PS7)');

  // A real session killed DURING its first turn -- the hardest PS7 case, and
  // the positive control that makes the negatives below mean something.
  //
  // The turn is started WITHOUT being awaited, exactly as `itemMidTurn` does
  // it, and for the reason that item's own comment already records: awaiting
  // it means the kill lands after the turn settles, and what gets measured is
  // an idle kill wearing a mid-first-turn label. The first version of this
  // item did await it -- the run reported `result=success` and the claim
  // "killed mid-first-turn" was false of the artifact even though it was true
  // of the ad-hoc probe this item was preserved from. `turnInFlight` below is
  // what makes that failure visible instead of silently weakening the case.
  const token = nonce('NONCE-INVALID');
  const origin = new ProbeSession({ label: 'r1-origin', options: buildOptions() });
  await origin.waitForReady();
  const inFlight = origin.runTurn(
    `Remember this exact token: ${token}. Then write out the numbers from 1 to 3000, one per line, with no other text. Do not stop early and do not abbreviate.`,
    180_000,
  );
  await sleep(5_000);
  const killedDuringFirstTurn = origin.turnInFlight;
  // Captured while the turn is still live: the session id has to exist before
  // the kill for the PS7 lookup below to mean anything.
  const originSessionId = origin.sessionId;
  console.log(`a first turn was still in flight at kill time: ${killedDuringFirstTurn}`);
  console.log(`origin session id: ${originSessionId ?? '(none)'}`);
  await killChildren(origin, 'r1-origin');
  const interrupted = await inFlight;
  account('r1-origin', interrupted);
  console.log(`${turnLine('turn 1 (interrupted)', interrupted)}`);

  if (!killedDuringFirstTurn) {
    verdicts.push({
      item: 'PS7 (getSessionInfo pre-flight)',
      verdict:
        'RECORDED NON-RESULT -- the first turn had already settled when the kill fired, so this run measured a COMPLETED-turn session, which is the easy case. The hard case (no assistant reply ever produced) was not exercised. Lengthen the generation or shorten the delay and re-run; do NOT read this run as covering PS7\'s adversarial case',
      stop: false,
      control: 'n/a -- the case under test never occurred',
    });
    return;
  }

  // --- PS7 ---
  h('PS7 -- getSessionInfo as a pre-flight');
  const liveLookup = originSessionId
    ? await getSessionInfo(originSessionId, { dir: process.cwd() })
    : undefined;
  const bogusId = randomUUID();
  const missingLookup = await getSessionInfo(bogusId, { dir: process.cwd() });
  const malformedLookup = await getSessionInfo('not-a-session-id-@@@', { dir: process.cwd() });

  console.log(`live session (killed mid-first-turn): defined=${liveLookup !== undefined} summary=${JSON.stringify((liveLookup as { summary?: string } | undefined)?.summary ?? null)}`);
  console.log(`nonexistent uuid: defined=${missingLookup !== undefined}`);
  console.log(`malformed id:     defined=${malformedLookup !== undefined}`);

  const ps7Holds = liveLookup !== undefined && missingLookup === undefined && malformedLookup === undefined;
  verdicts.push({
    item: 'PS7 (getSessionInfo pre-flight)',
    verdict: !originSessionId
      ? 'INDETERMINATE: the origin session never reported a session id, so the positive case could not be built'
      : ps7Holds
        ? 'HOLDS: a live session (killed mid-first-turn, no assistant reply) is reported; both invalid shapes report undefined, without throwing'
        : 'BROKEN: see the three lines above -- R1 pre-flights on this, and a false undefined discards a resumable conversation',
    stop: Boolean(originSessionId) && !ps7Holds,
    control: originSessionId
      ? 'the positive case is a REAL session this run created, not a fixture; the two negatives are measured in the same run'
      : 'no positive case available',
  });

  // --- PS6 ---
  h('PS6 -- resume an id the SDK cannot find');
  const invalid = new ProbeSession({ label: 'r1-invalid', options: buildOptions({ resume: bogusId }) });
  const t = await invalid.runTurn('Reply with only the word ok.');
  account('r1-invalid', t);
  await invalid.waitForStreamEnd(30_000);

  const sawSystemInit = invalid.sessionId !== null && invalid.allMessages.some((m) => m === 'system/init');
  const resultSubtype = t.result?.subtype ?? '(no result)';
  console.log(`messages observed: ${invalid.allMessages.join(', ') || '(none)'}`);
  console.log(`system:init seen: ${sawSystemInit}`);
  console.log(`result subtype: ${resultSubtype}  is_error=${t.result?.is_error ?? '(n/a)'}`);
  console.log(`stream ended: ${invalid.streamEnded ?? 'still open'}${invalid.streamError ? ` -- ${invalid.streamError}` : ''}`);

  // PS6 is an ABSENCE claim, so it needs positive evidence that the thing
  // whose absence is being reported actually ran to a terminal state. Without
  // this, a harness that silently did nothing -- a turn that timed out AND a
  // stream wait that returned on its own timeout -- produces exactly the same
  // observation as a genuine refusal, and would be reported as HOLDS.
  const reachedTerminal = t.result !== undefined || invalid.streamEnded !== null;
  verdicts.push({
    item: 'PS6 (a failed resume emits no system:init)',
    verdict: sawSystemInit
      ? 'BROKEN: a system:init arrived for a resume that failed -- R1\'s detector now reports every failed resume as a SUCCESS, silently'
      : reachedTerminal
        ? 'HOLDS: no system:init of any kind arrived; the failure surfaced as a terminal error instead'
        : 'INDETERMINATE: no system:init arrived, but the query never reached a terminal state either (no result, and the stream wait timed out). An absence observed from a harness that did nothing is not evidence -- re-run before reading anything into it',
    stop: sawSystemInit,
    control: reachedTerminal
      ? 'the origin session above reached system:init normally in this same run, so its absence here is attributable to the invalid resume rather than to the harness'
      : 'the control cannot be evaluated: the invalid session produced no terminal evidence',
  });
  invalid.close();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`probe-sdk-resume  started ${stamp()}`);
  console.log(`items: ${[...selected].join(' ')}`);
  console.log(`isolated CLAUDE_CONFIG_DIR: ${CONFIG_DIR}`);
  console.log(`model: ${MODEL}`);

  if (selected.has('--basic')) {
    await itemBasic();
    await itemMidTurn();
  }
  if (selected.has('--invalid')) await itemInvalidResume();
  if (selected.has('--post-compact')) await itemPostCompact();

  const isolation = verifyIsolation(CONFIG_DIR);
  h('Isolation check');
  console.log(`child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`);
  console.log(`session transcripts written there: ${isolation.files.length}`);
  for (const f of isolation.files) console.log(`  ${f}`);
  if (!isolation.ok) {
    console.error(
      'ISOLATION NOT VERIFIED: the child wrote no state into the throwaway config dir. A resume probe in particular cannot be trusted without this -- the resumed session may have been read from the operator\'s real config dir.',
    );
    return 2;
  }

  h('Verdicts');
  for (const v of verdicts) {
    console.log(`\n- ${v.item}\n    verdict: ${v.verdict}\n    control: ${v.control}`);
  }
  const t = totals();
  console.log(`\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`);

  return verdicts.some((v) => v.stop) ? 1 : 0;
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('probe could not run:', err);
      process.exit(2);
    });
}
