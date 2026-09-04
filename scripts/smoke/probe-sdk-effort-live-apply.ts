#!/usr/bin/env bun
/**
 * Premise probe for the mid-run reasoning-effort path on the `claude-sdk`
 * engine (agent-surface.md Phase 3): does
 * `Query.applyFlagSettings({ effortLevel })` actually change the effort a
 * LIVE session runs at, mid-session, over an `Options.effort` that was set
 * when the query was constructed? Measurement only -- this script changes no
 * production behavior and is not wired into CI, same class of tool as its
 * siblings `probe-sdk-instruction-loading.ts` and
 * `probe-sdk-post-tool-use-context.ts`.
 *
 * WHY THIS SCRIPT EXISTS -- the premise it refuted. The design for this
 * feature was written on the assumption that the SDK has NO runtime effort
 * setter at all: model changes would go through `Query.setModel`, and an
 * effort change would have to be applied by RESTARTING the worker in place
 * (deactivate then activate, the persisted row read again at `init`), with
 * the engine reporting an `effort-requires-restart` refusal back to the
 * server and the UI warning the user that changing effort restarts the
 * agent. That whole branch -- the refusal reason, the server-side
 * restart-in-place, and the UI sentence -- was removed BEFORE it shipped
 * because this probe measured the opposite: the flag layer overrides a
 * query-time effort live, and clearing it lands on the same level a fresh
 * session with no override runs at. Do not delete this script as redundant
 * with the unit tests: the unit tests pin what our code CALLS, and this is
 * the only thing in the repository that measures what the SDK DOES with it.
 *
 * WHY A NON-THROWING CALL PROVES NOTHING. `applyFlagSettings` takes a
 * partial settings object and merges it into the flag layer; a key it does
 * not act on is not an error. `probe-sdk-compaction.ts` measured exactly
 * that asymmetry on this same call: `autoCompactEnabled` was honored while
 * `autoCompactWindow` was silently ignored, in the same session, in the same
 * call shape. So only an OBSERVED EFFECT counts here, never a call that
 * returned without throwing.
 *
 * OBSERVABLES (two, because one of them is prose):
 *   - PRIMARY, structured: a `PostToolUse` hook's `input.effort.level`,
 *     which the vendored `sdk.d.ts` documents as "active effort level for
 *     the current turn, after any silent downgrade for the selected model".
 *     That "after any silent downgrade" clause is the reason this is the
 *     primary observable: it reports what the turn RAN at, which is the
 *     question, rather than what was requested.
 *   - CROSS-CHECK: `echo $CLAUDE_EFFORT` run through a `Bash` tool call.
 *     The same `sdk.d.ts` line documents that the level is "also exposed to
 *     hook commands and Bash as the CLAUDE_EFFORT env var", so this is a
 *     second, independent read of the same fact -- and it travels through
 *     the model's own answer, which is why it is the cross-check and not the
 *     primary.
 * Asking the model what effort it is using is NOT an observable and is
 * deliberately not done: it is exactly the "read a verdict out of generated
 * prose" shape that needs a control it cannot have here.
 *
 * POSITIVE CONTROL, and why it gates every verdict. Turn 1 of the `--set`
 * and `--clear` arms must observe `low` -- the value passed as
 * `Options.effort` at construction. If it does not, then on this build the
 * observables do not track `Options.effort` at all, and NOTHING can be
 * concluded from a later turn: an arm in that state reports INCONCLUSIVE,
 * never a negative. This is the difference between "the instrument can see,
 * and it sees no change" and "the instrument saw nothing".
 *
 * THE THREE ARMS:
 *
 *   --set     SUBJECT. `Options.effort: 'low'` at construction. Turn 1
 *             (control, expect `low`) -> `applyFlagSettings({ effortLevel:
 *             'high' })` -> turn 2. `high` on turn 2 means the flag layer
 *             overrode the query-time value on a live session.
 *
 *   --clear   WHAT CLEARING FALLS BACK TO. `Options.effort: 'low'` ->
 *             turn 1 (control, expect `low`) -> `applyFlagSettings({
 *             effortLevel: 'medium' })` -> turn 2 -> `applyFlagSettings({
 *             effortLevel: null })` -> turn 3.
 *
 *             `'medium'` is deliberate and is the part of this script most
 *             likely to be "simplified" wrongly by a later reader.
 *             `'high'` would CONFLATE three outcomes that must stay
 *             distinguishable on turn 3, because it is simultaneously a
 *             plausible set-value AND the SDK's own default: with `'high'`
 *             set on turn 2, a turn-3 reading of `high` cannot distinguish
 *             "the clear was ignored and the set value survived" from "the
 *             clear worked and fell back to the SDK default". With
 *             `'medium'` the three outcomes separate cleanly:
 *               turn 3 == 'low'    -> cleared, fell back to the STALE
 *                                     query-time `Options.effort`
 *               turn 3 == 'high'   -> cleared, fell back to the SDK's OWN
 *                                     default (query-time value is gone)
 *               turn 3 == 'medium' -> the clear was silently IGNORED
 *             The SDK documents `null` as the clear (`undefined` "is
 *             dropped by JSON serialization and has no effect"), which is
 *             why the clear is written as `null` here and in the engine.
 *
 *   --absent  BASELINE. `Options.effort` OMITTED entirely, one turn. This
 *             is what a fresh session with no override runs at -- i.e. what
 *             the discarded restart-based design would have produced for
 *             the clear case. Read together with `--clear`'s turn 3 it
 *             answers whether a live clear and a restart-without-override
 *             are observationally the same state.
 *
 * Default (no arm flag) = all three, in the order above.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user (this repo's own claude-sdk auth, not a provider key). BILLABLE --
 * six small turns total across all three arms. A manual gate, never a CI
 * job.
 *
 * Usage: bun scripts/smoke/probe-sdk-effort-live-apply.ts [--set] [--clear] [--absent]
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EffortLevel,
  HookCallbackMatcher,
  Options,
  SettingSource,
  SyncHookJSONOutput,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { EFFORT_LEVELS } from '../../packages/shared/src/types/embedded-agent-parameter-capabilities.ts';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  stamp,
  turnLine,
  turnSettled,
  unsettledReason,
  verifyIsolation,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

/**
 * The script's exit codes. A single "measured something" code cannot separate
 * "the premise holds" from "the premise fell", and this probe's own rule
 * section tells readers to re-run it on every SDK bump -- the moment the
 * distinction is the entire point of running it.
 */
export const PROBE_EXIT = {
  /** Measured, and PS9 HOLDS. */
  PREMISE_HOLDS: 0,
  /**
   * INCONCLUSIVE: a failed positive control, an `applyFlagSettings` that
   * threw, a turn that produced no readable level -- or a run that never
   * selected an arm bearing on PS9, which measured other things conclusively
   * but produced no reading of the premise.
   */
  INCONCLUSIVE: 1,
  /**
   * HARNESS failure: bad arguments, an unverified config-dir isolation, an
   * exception escaping `main`. Nothing about the SDK was measured.
   */
  HARNESS: 2,
  /** Measured, and PS9 is REFUTED. */
  PREMISE_REFUTED: 3,
} as const;

/** One line per code, printed with the verdicts so a reader need not look it up. */
const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.PREMISE_HOLDS]: 'measured, and PS9 holds',
  [PROBE_EXIT.INCONCLUSIVE]: 'inconclusive; no reading of PS9 was produced',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
  [PROBE_EXIT.PREMISE_REFUTED]: 'measured, and PS9 is REFUTED',
};

// ---------------------------------------------------------------------------
// Argument parsing -- done inside main() so importing this module (the
// import-safety guard under scripts/smoke/__tests__/) never touches argv or
// calls process.exit.
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--set', '--clear', '--absent'] as const;
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-effort-live-apply.ts [--set] [--clear] [--absent]\n' +
  '  Default (no arm flag) = all three, in that order.';

function parseArgs(argv: string[]): Set<string> {
  const selected = new Set<string>();
  for (const a of argv) {
    if ((ARM_FLAGS as readonly string[]).includes(a)) {
      selected.add(a);
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (selected.size === 0) for (const f of ARM_FLAGS) selected.add(f);
  return selected;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/**
 * A model that supports the effort parameter at all -- `sdk.d.ts` says the
 * hook's `effort` field is "absent for ... models without effort support",
 * so an unsupported model would make every arm INCONCLUSIVE on its control
 * turn rather than produce a wrong answer.
 */
const MODEL = 'claude-sonnet-5';
/** Matches production `sdk-engine.ts`'s `buildOptions`. */
const SETTING_SOURCES: SettingSource[] = [];
/** The query-time value the flag layer is asked to override. */
const QUERY_TIME_EFFORT: EffortLevel = 'low';

const startedAt = Date.now();
const perTurn = new Map<string, { tokens: number; cost: number }>();

function account(label: string, outcome: Pick<TurnOutcome, 'result'>): void {
  const r = outcome.result;
  if (!r) return;
  let prompt = 0;
  for (const mu of Object.values(r.modelUsage ?? {})) {
    prompt += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
  }
  perTurn.set(label, { tokens: prompt, cost: r.total_cost_usd ?? 0 });
}

function totals(): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const v of perTurn.values()) {
    tokens += v.tokens;
    cost += v.cost;
  }
  return { tokens, cost };
}

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}   [${stamp()}]\n${'='.repeat(72)}`);
}

/**
 * Mirrors `sdk-engine.ts`'s `buildOptions` pins for the fields this probe
 * cares about. `effort` is arm-specific (`undefined` for the `--absent`
 * baseline, which must OMIT the key rather than pass `undefined` through a
 * spread that would still declare it).
 */
function buildOptions(cwd: string, hooks: Options['hooks'], effort: EffortLevel | undefined): Options {
  const options: Options = {
    executable: 'bun',
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: SETTING_SOURCES,
    settings: { autoCompactEnabled: false },
    hooks,
  };
  if (effort !== undefined) options.effort = effort;
  return options;
}

/**
 * Records every `PostToolUse` firing's `input.effort.level`, tagged with the
 * turn that was in flight. The hook only ever OBSERVES -- it returns
 * `{ continue: true }` and injects nothing, so it cannot itself influence
 * what the turn runs at.
 */
class HookRecorder {
  private readonly entries: Array<{ turn: number; tool: string; level: string | undefined }> = [];
  turn = 0;

  readonly hooks: Options['hooks'];

  constructor() {
    const matcher: HookCallbackMatcher = {
      hooks: [
        async (input): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name !== 'PostToolUse') return { continue: true };
          this.entries.push({
            turn: this.turn,
            tool: String(input.tool_name),
            level: input.effort?.level,
          });
          return { continue: true };
        },
      ],
    };
    this.hooks = { PostToolUse: [matcher] };
  }

  /** Firings observed during `turn`, in order. */
  forTurn(turn: number): Array<{ tool: string; level: string | undefined }> {
    return this.entries.filter((e) => e.turn === turn).map(({ tool, level }) => ({ tool, level }));
  }

  /**
   * The level the given turn ran at, or `undefined` if the hook never fired
   * (the model declined to call a tool) or fired without an `effort` field.
   * The FIRST firing is used: later firings in the same turn cannot report a
   * different level, since the level is a property of the turn.
   */
  levelFor(turn: number): string | undefined {
    return this.forTurn(turn)[0]?.level;
  }
}

/**
 * Every measured turn is this same prompt: it forces a tool call (which is
 * what makes the `PostToolUse` hook fire at all) and carries the env-var
 * cross-check in the same turn, so both observables describe one turn rather
 * than two.
 */
const ECHO_PROMPT =
  'Run exactly this Bash command and then reply with ONLY the single line it printed, nothing else:\n' +
  'echo EFFORT_IS=$CLAUDE_EFFORT';

/** The cross-check observable, parsed out of the turn's own answer. */
function echoed(text: string): string | null {
  const m = /EFFORT_IS=([a-zA-Z0-9_-]*)/.exec(text);
  return m ? (m[1] === '' ? '(empty)' : m[1]) : null;
}

interface Measurement {
  label: string;
  outcome: TurnOutcome;
  /** `null` when the turn did not settle -- never a level. */
  hookLevel: string | null;
  echoLevel: string | null;
}

/**
 * One measured turn: run it, log it, and read both observables -- but only
 * if the turn actually settled. An unsettled turn has the same SHAPE as a
 * turn that ran at some other level (no hook firing, no echoed line), so
 * reading a level out of one would silently manufacture an empirical
 * negative. `turnSettled` is the harness's single writer of that predicate.
 */
async function measure(
  s: ProbeSession,
  recorder: HookRecorder,
  turn: number,
  label: string,
): Promise<Measurement> {
  recorder.turn = turn;
  const outcome = await s.runTurn(ECHO_PROMPT);
  account(label, outcome);
  console.log(turnLine(label, outcome));
  const unsettled = unsettledReason(outcome, label);
  if (unsettled) console.log(unsettled);
  const settled = turnSettled(outcome);
  const hookLevel = settled ? (recorder.levelFor(turn) ?? null) : null;
  const echoLevel = settled ? echoed(outcome.text) : null;
  console.log(
    `${label}: hook=${hookLevel ?? 'ABSENT'} echo=${echoLevel ?? 'ABSENT'} ` +
      `firings=${JSON.stringify(recorder.forTurn(turn))}`,
  );
  return { label, outcome, hookLevel, echoLevel };
}

/**
 * The two observables agreeing is the ordinary case; when only one of them
 * reported, that one is the reading. When they DISAGREE there is no reading
 * at all -- returning either would be a choice the data does not support.
 */
function observedLevel(m: Measurement): string | null {
  if (m.hookLevel !== null && m.echoLevel !== null) {
    return m.hookLevel === m.echoLevel ? m.hookLevel : null;
  }
  return m.hookLevel ?? m.echoLevel;
}

function disagreementNote(m: Measurement): string | null {
  if (m.hookLevel !== null && m.echoLevel !== null && m.hookLevel !== m.echoLevel) {
    return `${m.label}: the two observables DISAGREE (hook=${m.hookLevel} echo=${m.echoLevel}); no level can be read from this turn.`;
  }
  return null;
}

function buildScratchCwd(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-sdk-effort-${label}-`));
  try {
    writeFileSync(join(dir, 'README.md'), 'effort probe scratch\n');
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Applies one flag-layer write and reports whether the CALL itself failed.
 * A returned `null` means the call came back without throwing, which -- per
 * this file's header -- proves nothing on its own; the next turn is what
 * measures it.
 */
async function applyEffort(s: ProbeSession, level: EffortLevel | null): Promise<string | null> {
  const shown = level === null ? 'null (clear)' : `'${level}'`;
  try {
    await s.q.applyFlagSettings({ effortLevel: level });
    console.log(`applyFlagSettings({ effortLevel: ${shown} }) -> returned without error`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`applyFlagSettings({ effortLevel: ${shown} }) THREW: ${message}`);
    return message;
  }
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/**
 * An arm's reading ON PS9 -- `applyFlagSettings({ effortLevel })` changes the
 * effort a LIVE session runs at (embedded-agent-sdk-engine.md 5). Required on
 * every `ArmResult` rather than optional, so a new arm has to state where it
 * stands instead of defaulting into silence.
 *
 * `null` for a conclusive measurement that does not bear on PS9 at all -- the
 * `--absent` baseline, which reads a fresh session and asks nothing of the
 * flag layer -- and for every inconclusive verdict, whose `conclusive: false`
 * is the fact that matters.
 */
type PremiseReading = 'holds' | 'refuted' | null;

interface ArmResult {
  flag: (typeof ARM_FLAGS)[number];
  verdict: string;
  /** True only for a verdict that measured what the arm exists to measure. */
  conclusive: boolean;
  premise: PremiseReading;
}

/**
 * Maps the arms' own verdicts onto {@link PROBE_EXIT}.
 *
 * A conclusive REFUTATION outranks an inconclusive sibling arm: the
 * refutation is a measurement in its own right, and reporting it as
 * INCONCLUSIVE because some other arm did not settle would hide exactly the
 * result this mapping exists to surface.
 *
 * `PREMISE_HOLDS` requires at least one arm that actually read the premise.
 * A `--absent`-only run is conclusive and says nothing about PS9, so it exits
 * INCONCLUSIVE rather than claiming a premise nobody measured.
 *
 * @internal Exported for the sibling unit test -- importing this module runs
 * nothing (see the `import.meta.main` guard at the foot of the file).
 */
export function exitCodeFor(
  results: readonly { conclusive: boolean; premise: PremiseReading }[],
): number {
  if (results.some((r) => r.premise === 'refuted')) return PROBE_EXIT.PREMISE_REFUTED;
  if (!results.every((r) => r.conclusive)) return PROBE_EXIT.INCONCLUSIVE;
  if (!results.some((r) => r.premise === 'holds')) return PROBE_EXIT.INCONCLUSIVE;
  return PROBE_EXIT.PREMISE_HOLDS;
}

/** Runs `body` against a fresh isolated session and always tears it down. */
async function withSession(
  label: string,
  effort: EffortLevel | undefined,
  body: (s: ProbeSession, recorder: HookRecorder) => Promise<ArmResult>,
): Promise<ArmResult> {
  const cwd = buildScratchCwd(label);
  try {
    const recorder = new HookRecorder();
    const options = buildOptions(cwd, recorder.hooks, effort);
    console.log(
      `arm ${label}: model=${MODEL} query-time Options.effort=${effort === undefined ? '(omitted)' : `'${effort}'`} cwd=${cwd}`,
    );
    const s = new ProbeSession({ label, options, pollUsage: false });
    try {
      console.log(`arm ${label} ready: ${await s.waitForReady()}`);
      return await body(s, recorder);
    } finally {
      s.close();
      await s.waitForStreamEnd();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** SUBJECT: does the flag layer override a query-time effort, live? */
async function runSetArm(): Promise<ArmResult> {
  h("Arm --set  (SUBJECT: 'low' at construction, then applyFlagSettings 'high')");
  return withSession('effort-set', QUERY_TIME_EFFORT, async (s, recorder) => {
    const t1 = await measure(s, recorder, 1, 'set/turn1 (control, expect low)');
    const applyError = await applyEffort(s, 'high');
    const t2 = await measure(s, recorder, 2, 'set/turn2 (expect high if live)');

    for (const m of [t1, t2]) {
      const note = disagreementNote(m);
      if (note) console.log(note);
    }
    const control = observedLevel(t1);
    const after = observedLevel(t2);
    if (control !== 'low') {
      return {
        flag: '--set',
        conclusive: false,
        premise: null,
        verdict:
          `INCONCLUSIVE -- the positive control turn read ${control ?? 'nothing'} rather than 'low', so the ` +
          'observables do not track Options.effort on this build. Nothing can be concluded from turn 2.',
      };
    }
    if (applyError !== null) {
      return {
        flag: '--set',
        conclusive: false,
        premise: null,
        verdict: `INCONCLUSIVE -- applyFlagSettings itself threw (${applyError}); there was no write to measure.`,
      };
    }
    if (after === null) {
      return {
        flag: '--set',
        conclusive: false,
        premise: null,
        verdict: 'INCONCLUSIVE -- turn 2 produced no readable level (see its own line above).',
      };
    }
    if (after === 'high') {
      return {
        flag: '--set',
        conclusive: true,
        // The measurement PS9 names, in the affirmative.
        premise: 'holds',
        verdict:
          "LIVE -- applyFlagSettings({ effortLevel: 'high' }) overrode the query-time Options.effort on a " +
          'running session. An effort change needs no restart on this engine.',
      };
    }
    if (after === 'low') {
      return {
        flag: '--set',
        conclusive: true,
        // PS9 fell. This is the shipped design's load-bearing premise, so a
        // run that lands here must not exit like a run that merely measured.
        premise: 'refuted',
        verdict:
          'NOT LIVE -- the flag layer did not override the query-time Options.effort. The restart-based ' +
          'design this probe retired would be required after all; re-open that branch before shipping.',
      };
    }
    return {
      flag: '--set',
      conclusive: false,
      premise: null,
      verdict: `UNEXPECTED -- turn 2 ran at '${after}', which is neither the query-time value nor the requested one.`,
    };
  });
}

/**
 * The `--clear` arm's turn-3 reading, mapped onto a verdict. Reached only
 * once that arm's positive control and its turn-2 set have both been
 * established, so every branch here is about the CLEAR and nothing else.
 *
 * Extracted from {@link runClearArm} so the mapping is testable without the
 * billed turns that produce its input -- same reason and same idiom as
 * {@link exitCodeFor}.
 *
 * The DEFAULT-FALLBACK branch is constrained to levels the SDK is known to
 * have (`EFFORT_LEVELS`, itself pinned both directions against the SDK's own
 * `EffortLevel` union). "Neither the set value nor the query-time one" is not
 * on its own enough to call a reading "the SDK's own default": a level this
 * repository has never heard of -- a later SDK renaming or adding one -- is a
 * reading nobody has interpreted, and reporting it as a CONCLUSIVE
 * `premise: 'holds'` would exit 0 on a premise no turn measured. That is the
 * same failure the exit-code mapping exists to prevent, one level further in,
 * so an unrecognized level lands on the `--set` arm's UNEXPECTED shape
 * instead: inconclusive, with the level named.
 *
 * @internal Exported for the sibling unit test -- importing this module runs
 * nothing (see the `import.meta.main` guard at the foot of the file).
 */
export function classifyClearFallback(afterClear: string | null): Omit<ArmResult, 'flag'> {
  if (afterClear === 'medium') {
    return {
      conclusive: true,
      // A write to the flag layer that the live session ignored is PS9
      // failing in the clearing direction, not a mere fallback surprise.
      premise: 'refuted',
      verdict:
        "IGNORED -- the clear did nothing: turn 3 still ran at 'medium'. A cleared override would stay in " +
        'effect for the life of the process, which the engine must then work around.',
    };
  }
  if (afterClear === 'low') {
    return {
      conclusive: true,
      // Landing back on the query-time value contradicts the measurement
      // 5 records and the shipped design rests on.
      premise: 'refuted',
      verdict:
        "STALE FALLBACK -- clearing fell back to the query-time Options.effort ('low'), which by then is a " +
        'value no persisted row holds. A live clear and a fresh session would diverge.',
    };
  }
  if (afterClear === null) {
    return {
      conclusive: false,
      premise: null,
      verdict: 'INCONCLUSIVE -- turn 3 produced no readable level (see its own line above).',
    };
  }
  if (!(EFFORT_LEVELS as readonly string[]).includes(afterClear)) {
    return {
      conclusive: false,
      premise: null,
      verdict:
        `UNEXPECTED -- turn 3 ran at '${afterClear}', which is not one of the effort levels this repository ` +
        `knows (${EFFORT_LEVELS.join(', ')}). Nothing is concluded from a level nobody has interpreted; ` +
        'check whether the SDK renamed or added one, and re-read this arm against the new set.',
    };
  }
  return {
    conclusive: true,
    // The clear reached the live session and landed on the SDK's own
    // default -- the fallback 5 records, so PS9 holds in this direction.
    premise: 'holds',
    verdict:
      `DEFAULT FALLBACK -- clearing fell back to '${afterClear}', which is neither the set value nor the ` +
      "stale query-time one, i.e. the SDK's own default. Compare with the --absent arm.",
  };
}

/** What does clearing the flag layer fall back to? */
async function runClearArm(): Promise<ArmResult> {
  h("Arm --clear  ('low' at construction -> 'medium' -> null; what does turn 3 run at?)");
  return withSession('effort-clear', QUERY_TIME_EFFORT, async (s, recorder) => {
    const t1 = await measure(s, recorder, 1, 'clear/turn1 (control, expect low)');
    const setError = await applyEffort(s, 'medium');
    const t2 = await measure(s, recorder, 2, 'clear/turn2 (expect medium if live)');
    const clearError = await applyEffort(s, null);
    const t3 = await measure(s, recorder, 3, 'clear/turn3 (the measurement)');

    for (const m of [t1, t2, t3]) {
      const note = disagreementNote(m);
      if (note) console.log(note);
    }
    const control = observedLevel(t1);
    const afterSet = observedLevel(t2);
    const afterClear = observedLevel(t3);
    if (control !== 'low') {
      return {
        flag: '--clear',
        conclusive: false,
        premise: null,
        verdict:
          `INCONCLUSIVE -- the positive control turn read ${control ?? 'nothing'} rather than 'low'. ` +
          'Nothing can be concluded from the later turns.',
      };
    }
    if (setError !== null || clearError !== null) {
      return {
        flag: '--clear',
        conclusive: false,
        premise: null,
        verdict: `INCONCLUSIVE -- an applyFlagSettings call threw (set: ${setError ?? 'ok'}; clear: ${clearError ?? 'ok'}).`,
      };
    }
    if (afterSet !== 'medium') {
      return {
        flag: '--clear',
        conclusive: false,
        premise: null,
        verdict:
          `INCONCLUSIVE -- turn 2 read ${afterSet ?? 'nothing'} rather than 'medium', so the value being ` +
          'cleared on turn 3 was never established.',
      };
    }
    return { flag: '--clear', ...classifyClearFallback(afterClear) };
  });
}

/** BASELINE: what does a session with no override at all run at? */
async function runAbsentArm(): Promise<ArmResult> {
  h('Arm --absent  (BASELINE: Options.effort omitted entirely, one turn)');
  return withSession('effort-absent', undefined, async (s, recorder) => {
    const t1 = await measure(s, recorder, 1, 'absent/turn1');
    const note = disagreementNote(t1);
    if (note) console.log(note);
    const level = observedLevel(t1);
    if (level === null) {
      return {
        flag: '--absent',
        conclusive: false,
        premise: null,
        verdict: 'INCONCLUSIVE -- the turn produced no readable level (see its own line above).',
      };
    }
    return {
      flag: '--absent',
      conclusive: true,
      // A baseline read of a fresh session: it asks nothing of the flag
      // layer, so it bears on PS9 in neither direction.
      premise: null,
      verdict:
        `BASELINE = '${level}' -- a fresh session with no effort override runs at '${level}'. This is the ` +
        'state a restart-without-override would produce, and the value --clear\'s turn 3 must be compared against.',
    };
  });
}

/**
 * The CLI version reported by `system:init` is not something `ProbeSession`
 * exposes (its consume loop records message labels, not bodies), and
 * widening the shared harness for one probe's one field is not worth it.
 * `claude --version` reads the same fact, and every environment that can run
 * this probe has that binary by definition.
 */
function claudeCliVersion(): string {
  const result = Bun.spawnSync(['claude', '--version']);
  if (result.exitCode !== 0) {
    return `(could not determine: exit ${result.exitCode}, stderr=${result.stderr.toString().trim()})`;
  }
  return result.stdout.toString().trim();
}

async function main(): Promise<number> {
  const selected = parseArgs(process.argv.slice(2));
  const configDir = isolateClaudeConfigDir('effort-live-apply');

  try {
    console.log(`probe-sdk-effort-live-apply  started ${stamp()}`);
    console.log(`arms: ${[...selected].join(' ')}`);
    console.log(`isolated CLAUDE_CONFIG_DIR: ${configDir}`);
    console.log(`model: ${MODEL}`);

    const sdkPackageJson = await Bun.file(
      join(import.meta.dir, '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    ).json();
    console.log(`@anthropic-ai/claude-agent-sdk version: ${sdkPackageJson.version}`);
    console.log(`claude CLI version (from \`claude --version\`): ${claudeCliVersion()}`);

    const results: ArmResult[] = [];
    if (selected.has('--set')) results.push(await runSetArm());
    if (selected.has('--clear')) results.push(await runClearArm());
    if (selected.has('--absent')) results.push(await runAbsentArm());

    const isolation = verifyIsolation(configDir);
    h('Isolation check');
    console.log(
      `child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`,
    );
    if (!isolation.ok) {
      console.error(
        'ISOLATION NOT VERIFIED: the child wrote no state into the throwaway config dir. This probe cannot be ' +
          "trusted without this -- it may have run against the operator's real config dir.",
      );
      return PROBE_EXIT.HARNESS;
    }

    h('Verdict');
    for (const r of results) {
      console.log(`${r.flag}: ${r.verdict}`);
    }

    // The cross-arm reading, stated only when both arms it needs were run
    // AND both concluded -- this is the sentence the shipped design rests
    // on, so it must never be printed from a partial run.
    const clear = results.find((r) => r.flag === '--clear');
    const absent = results.find((r) => r.flag === '--absent');
    if (clear?.conclusive && absent?.conclusive) {
      console.log(
        '\nCross-arm: compare --clear\'s turn 3 level against --absent\'s baseline. Equal means a live clear ' +
          'and a fresh session with no override are the SAME state, so a restart buys nothing for the clear ' +
          'case; unequal means the two paths diverge and the difference has to be designed for.',
      );
    }

    const code = exitCodeFor(results);
    console.log(`\nexit code ${code} -- ${EXIT_CODE_MEANINGS[code]}`);

    const t = totals();
    console.log(
      `\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  ` +
        `cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`,
    );

    return code;
  } finally {
    // The throwaway CLAUDE_CONFIG_DIR is not cleaned up by any other exit
    // path -- every reachable return/throw from the try block above goes
    // through here. Per-arm scratch cwds are cleaned up independently, in
    // `withSession`'s own `finally`.
    rmSync(configDir, { recursive: true, force: true });
  }
}

// Guarded: importing this module must not fire a billed run as a side
// effect. `import.meta.main` is false for an importer, true only when this
// file is the entry point.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('probe could not run:', err);
      process.exit(PROBE_EXIT.HARNESS);
    });
}
