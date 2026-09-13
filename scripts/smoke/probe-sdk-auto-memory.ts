#!/usr/bin/env bun
/**
 * Task 0 gate probe for epic #1636 Phase 2 (Issue #1658): does the SDK's
 * documented auto-memory mechanism (`Options.settings.autoMemoryEnabled` /
 * `.autoMemoryDirectory`, and the observable `SDKMemoryRecallMessage` event)
 * actually work on a headless `claude-sdk` session, before any Phase 2
 * implementation design is written? Measurement only -- this script changes
 * no production behavior and is not wired into CI, same class of tool as its
 * siblings `probe-sdk-instruction-loading.ts` / `probe-sdk-effort-live-apply.ts`
 * / `probe-sdk-post-tool-use-context.ts`.
 *
 * WHY THIS PROBE EXISTS. Epic #1636's gap 2 framed auto-memory as
 * "unreachable" from the `claude-sdk` arm, citing #1348 -- a real but
 * accidental, non-reproducible observation from a single quick session.
 * `packages/embedded-agent/src/sdk-engine.ts`'s `buildOptions` sets neither
 * `autoMemoryEnabled` nor `autoMemoryDirectory` today, so some undeclared
 * SDK default is very likely already active on every `claude-sdk` worker,
 * unconfigured and unobserved. This script replaces the accident with a
 * controlled, four-arm measurement.
 *
 * TWO CORRECTIONS TO THE ISSUE'S OWN WORDING, confirmed against the vendored
 * `sdk.d.ts` and agreed by the Architect (2026-09-13, session message) after
 * this script's own delegate found them while implementing:
 *
 *   1. The Issue asked Arm B to capture a `memory_type` field on
 *      `SDKMemoryRecallMessage`. That field does not exist there --
 *      `memory_type: 'User'|'Project'|'Local'|'Managed'` belongs to a
 *      DIFFERENT, unrelated type (`InstructionsLoadedHookInput`, the
 *      CLAUDE.md/rules loader hook). What `SDKMemoryRecallMessage.memories[]`
 *      actually carries is `scope: 'personal'|'team'|'organization'` (plus a
 *      top-level `mode: 'select'|'synthesize'`), which the Architect agreed
 *      is in fact the more direct answer to Arm B's actual question (a
 *      "personal" vs. something-else distinction is exactly the privacy-scope
 *      question Arm B exists to identify). This script reports `scope`/`mode`,
 *      never `memory_type`.
 *   2. `autoMemoryEnabled` / `autoMemoryDirectory` are not direct `Options`
 *      fields -- they live on the `Settings` interface, reached via
 *      `Options.settings?: string | Settings`, the same nesting
 *      `sdk-engine.ts`'s sibling probes already use for `autoCompactEnabled`
 *      (see `buildOptions` below). Functionally identical outcome to the
 *      Issue's wording, just a nesting correction.
 *
 * A THIRD ADAPTATION: the auto-memory sanitized-cwd algorithm and the
 * memory-recall supervisor's own logic are NOT present anywhere in the
 * vendored `@anthropic-ai/claude-agent-sdk` npm bundle (confirmed by
 * grepping `sdk.mjs` for "memory_recall" and for a sanitizer -- zero hits);
 * that logic lives inside the `claude` CLI binary the SDK spawns, which this
 * repo has no source for. Rather than guess a sanitizer, every arm that needs
 * the SDK's own default `autoMemoryDirectory` for a given scratch `cwd`
 * DISCOVERS it empirically at runtime: run one turn at that `cwd` with
 * `autoMemoryEnabled: true` and diff the isolated `CLAUDE_CONFIG_DIR/projects/`
 * listing to learn the directory the SDK itself created. This is the same
 * "does the default land where we'd expect" premise Arm D was always after,
 * without reverse-engineering a sanitizer we can't read.
 *
 * FOUR ARMS, each against a disposable scratch git-free cwd (auto-memory is
 * cwd-keyed, not repo-keyed) and a throwaway, isolated `CLAUDE_CONFIG_DIR` --
 * no real user memory directory is ever touched, by construction (every
 * `~/.claude/...`-rooted path the SDK documents is redirected under the
 * isolated config dir, confirmed the same way every sibling probe's own
 * `verifyIsolation()` check confirms it for session storage generally):
 *
 *   --a  RECALL: seed a nonce directly into the SDK's OWN default
 *        Project-scope memory file (path discovered per the adaptation
 *        above), ask a fresh session at the same cwd whether it knows the
 *        fact. Observes both the MECHANISM (`SDKMemoryRecallMessage`) and
 *        the OUTCOME (the model's answer), with a negative-control cwd
 *        (nothing seeded) in the same run.
 *   --b  LEAK: at a cwd with nothing ever seeded, ask a broad "what do you
 *        know about me" question and report whether anything surfaces, and
 *        if so, its `scope`/`mode` -- re-deriving #1348's finding under
 *        controlled conditions. Content is NEVER logged, only scope/mode and
 *        whether the surfaced path lies within this run's own isolated
 *        config dir (this run's own scratch data) or not (a real leak from
 *        elsewhere).
 *
 *        SCOPE LIMITATION (Architect ruling, 2026-09-13): because every arm
 *        runs under an isolated, throwaway `CLAUDE_CONFIG_DIR`, this arm can
 *        only ever observe a recall whose `path` is NOT rooted under that
 *        throwaway config dir -- in practice `scope: 'organization'` (an
 *        https URL) and, in principle, `'team'`. The `'personal'`/User-scope
 *        channel that #1348 actually observed lives outside any
 *        `CLAUDE_CONFIG_DIR`-relative path this isolation can redirect, so
 *        this arm cannot reach it by construction. **A `NO LEAK` result from
 *        this arm must never be read as covering User-scope** -- #1348
 *        remains un-re-derived for that channel. A synthetic User-scope seed
 *        (writing throwaway content into the isolation copy's own User-scope
 *        location before the run) would close this gap; tracked separately
 *        as Issue #1663 rather than folded into this arm, since seeding a
 *        copy of the real memory tree was rejected as unbounded input
 *        through a billed turn.
 *   --c  WRITE: tell the model something worth remembering, poll for a file
 *        to appear under the default directory within a bounded timeout.
 *   --d  REDIRECT: set `autoMemoryDirectory` explicitly and confirm both a
 *        read and a write land at the configured path, and that the write
 *        does not ALSO leak to the default location.
 *
 * `--expect-no-recall` (arm A) / `--expect-no-write` (arm C) run their arm
 * with the seeding / write-prompting step deliberately skipped and confirm
 * the probe's OWN detection correctly reports absence -- per `workflow.md`'s
 * "a check's existence is not its detection power", applied to this probe's
 * own apparatus before its numbers are trusted.
 *
 * EXIT CODES -- a measurement script, not a pass/fail gate (same shape as
 * `probe-compaction-fidelity.ts`): 0 means every requested arm produced a
 * definite measurement, REGARDLESS of which way any individual measurement
 * came out. 1 means at least one requested arm was inconclusive. 2 means the
 * harness itself failed (no authenticated `claude` CLI, spawn failure,
 * isolation not verified) and nothing was measured.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user (this repo's own claude-sdk auth, not a provider key). Roughly
 * 6-10 small turns total across the four arms, plus bounded local-filesystem
 * polling for write detection. A manual gate, never a CI job.
 *
 * Usage: bun scripts/smoke/probe-sdk-auto-memory.ts [--a] [--b] [--c] [--d] [--expect-no-recall] [--expect-no-write]
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Options, Settings } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  turnSettled,
  unsettledReason,
  verifyIsolation,
  type MemoryRecallMessage,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

export const PROBE_EXIT = {
  /** Harness ran to completion; every requested arm produced a definite measurement. */
  OK: 0,
  /** At least one requested arm was inconclusive (a turn that never settled, a failed positive control, ...). */
  INCONCLUSIVE: 1,
  /** Harness failure -- nothing was measured. */
  HARNESS: 2,
} as const;

const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.OK]: 'harness ran to completion; every requested arm produced a definite measurement',
  [PROBE_EXIT.INCONCLUSIVE]: 'at least one requested arm was inconclusive',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
};

/**
 * Every arm's own verdict, regardless of which way the measurement came out.
 * `premise` is `null` for arms (or polarity runs) that do not assert a
 * for/against reading -- Arm B is a pure measurement with no expected
 * direction, and a CONFIRMED-ABSENCE polarity run measured the detector, not
 * the feature.
 *
 * @internal Exported for the sibling unit test.
 */
export interface Verdict {
  conclusive: boolean;
  premise: 'holds' | 'refuted' | null;
  note: string;
}

export interface ArmVerdict extends Verdict {
  arm: 'A' | 'B' | 'C' | 'D';
}

function inconclusive(note: string): Verdict {
  return { conclusive: false, premise: null, note: `INCONCLUSIVE -- ${note}` };
}

/**
 * Maps every arm's own conclusiveness onto the script's exit code. Whether a
 * premise held or was refuted never changes the CODE (unlike
 * `probe-sdk-effort-live-apply.ts`'s 4-code scheme) -- this probe measures,
 * it does not gate, per this Issue's own exit-code spec.
 *
 * @internal Exported for the sibling unit test.
 */
export function exitCodeFor(results: readonly { conclusive: boolean }[]): number {
  if (results.length === 0) return PROBE_EXIT.INCONCLUSIVE;
  return results.every((r) => r.conclusive) ? PROBE_EXIT.OK : PROBE_EXIT.INCONCLUSIVE;
}

// ---------------------------------------------------------------------------
// Arm A (recall) classification
// ---------------------------------------------------------------------------

export interface ArmAInput {
  settled: boolean;
  expectNoRecall: boolean;
  measRecallHit: boolean;
  measTextHit: boolean;
  ctrlRecallHit: boolean;
  ctrlTextHit: boolean;
}

/**
 * Pure classifier for Arm A's four observed booleans. Extracted so the
 * decision tree is testable without the billed turns that produce its
 * input -- same idiom as `probe-sdk-effort-live-apply.ts`'s `exitCodeFor` /
 * `classifyClearFallback`.
 *
 * The negative control is checked FIRST and unconditionally: a control cwd
 * (nothing ever seeded there) that recalls or answers with the nonce means
 * the positive control failed, and nothing about the seeded cwd's own
 * result can be trusted -- this mirrors `probe-sdk-effort-live-apply.ts`'s
 * "the positive control turn gates every verdict" rule.
 *
 * @internal Exported for the sibling unit test.
 */
export function classifyArmA(input: ArmAInput): Verdict {
  if (!input.settled) {
    return inconclusive('the measurement or control turn did not settle.');
  }
  if (input.ctrlRecallHit || input.ctrlTextHit) {
    return inconclusive(
      'the negative-control cwd (nothing seeded there) recalled or answered with the nonce; the control failed, so nothing can be concluded about the seeded cwd.',
    );
  }
  if (input.expectNoRecall) {
    if (input.measRecallHit || input.measTextHit) {
      return {
        conclusive: false,
        premise: null,
        note: 'POLARITY FAILURE -- the nonce surfaced even though the seed step was deliberately skipped; the detector cannot be trusted.',
      };
    }
    return {
      conclusive: true,
      premise: null,
      note: "CONFIRMED ABSENCE (polarity) -- no recall and no nonce in the model's answer when seeding was deliberately skipped.",
    };
  }
  if (input.measRecallHit || input.measTextHit) {
    return {
      conclusive: true,
      premise: 'holds',
      note: `RECALL WORKS -- mechanism(SDKMemoryRecallMessage)=${input.measRecallHit} outcome(model's answer)=${input.measTextHit}, from the default Project-scope path; the negative-control cwd stayed silent.`,
    };
  }
  return {
    conclusive: true,
    premise: 'refuted',
    note: "RECALL DOES NOT WORK -- neither the mechanism nor the model's answer surfaced the seeded nonce from the default Project-scope path.",
  };
}

// ---------------------------------------------------------------------------
// Arm C (write) classification
// ---------------------------------------------------------------------------

export interface ArmCInput {
  settled: boolean;
  slugFound: boolean;
  expectNoWrite: boolean;
  contentFound: boolean;
  filePath?: string;
  elapsedMs: number;
  timeoutMs: number;
}

/** @internal Exported for the sibling unit test. */
export function classifyArmC(input: ArmCInput): Verdict {
  if (!input.settled) {
    return inconclusive('the turn did not settle.');
  }
  if (input.expectNoWrite) {
    if (input.contentFound) {
      return {
        conclusive: false,
        premise: null,
        note: `POLARITY FAILURE -- memory-directory content appeared (${input.filePath ?? '(unknown path)'}) even though no "remember this" instruction was given; the write detector cannot be trusted.`,
      };
    }
    return {
      conclusive: true,
      premise: null,
      note: `CONFIRMED ABSENCE (polarity) -- no memory-directory content appeared within ${input.timeoutMs}ms after a neutral turn${input.slugFound ? '' : ' (no project directory even appeared)'}.`,
    };
  }
  if (!input.slugFound) {
    return {
      conclusive: true,
      premise: 'refuted',
      note: 'WRITE DOES NOT WORK -- no project directory appeared under the default location at all within this turn.',
    };
  }
  if (input.contentFound) {
    return {
      conclusive: true,
      premise: 'holds',
      note: `WRITE WORKS -- the nonce persisted to ${input.filePath ?? '(unknown path)'} within ${input.elapsedMs}ms.`,
    };
  }
  return {
    conclusive: true,
    premise: 'refuted',
    note: `WRITE DOES NOT WORK -- a project directory (transcript) appeared, but no memory-directory content containing the nonce appeared within ${input.timeoutMs}ms.`,
  };
}

// ---------------------------------------------------------------------------
// Arm D (redirect) classification
// ---------------------------------------------------------------------------

export interface ArmDReadMeasurement {
  settled: boolean;
  recallHit: boolean;
  textHit: boolean;
}

export interface ArmDWriteMeasurement {
  settled: boolean;
  writeFound: boolean;
  writeFilePath?: string;
  defaultLeaked: boolean;
}

export interface ArmDInput {
  read: ArmDReadMeasurement;
  write: ArmDWriteMeasurement;
}

/** @internal Exported for the sibling unit test. */
export function classifyArmD(input: ArmDInput): Verdict {
  if (!input.read.settled || !input.write.settled) {
    return inconclusive('the read or write sub-test turn did not settle.');
  }
  const readWorks = input.read.recallHit || input.read.textHit;
  const writeWorks = input.write.writeFound;
  const writeClean = !input.write.defaultLeaked;
  if (readWorks && writeWorks && writeClean) {
    return {
      conclusive: true,
      premise: 'holds',
      note: 'REDIRECT WORKS -- both read and write landed at the explicitly overridden autoMemoryDirectory, and the write did not also appear at the default location.',
    };
  }
  const parts: string[] = [];
  if (!readWorks) parts.push('read did NOT recall from the override');
  if (!writeWorks) parts.push('write did NOT appear at the override within the timeout');
  if (writeWorks && !writeClean) parts.push('write ALSO leaked to the default location, so the override is not exclusive');
  return {
    conclusive: true,
    premise: 'refuted',
    note: `REDIRECT DOES NOT FULLY WORK -- ${parts.join('; ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Privacy: Arm B's redaction (never logs `content`, ever)
// ---------------------------------------------------------------------------

export interface RedactedRecallEntry {
  scope: 'personal' | 'team' | 'organization';
  withinIsolatedConfigDir: boolean;
  pathBasename: string;
}

/**
 * Summarizes one `SDKMemoryRecallMessage.memories[]` entry for safe logging.
 * `content` is NEVER read or returned here -- per this Issue's AC, if real
 * content from the executing account's own memory surfaces, the probe's job
 * is to report WHICH SCOPE leaked, not WHAT leaked. `path` is basenamed and
 * only when it demonstrably lies inside THIS run's own isolated
 * `CLAUDE_CONFIG_DIR` (this run's own scratch data); anything else is
 * reported only as "outside the isolated config dir", never as a path.
 *
 * @internal Exported for the sibling unit test.
 */
export function redactRecallEntry(entry: { path: string; scope: 'personal' | 'team' | 'organization' }, configDir: string): RedactedRecallEntry {
  const within = entry.path.startsWith(configDir);
  return {
    scope: entry.scope,
    withinIsolatedConfigDir: within,
    pathBasename: within ? basename(entry.path) : '(redacted -- outside isolated CLAUDE_CONFIG_DIR)',
  };
}

// ---------------------------------------------------------------------------
// Argument parsing -- done inside main() so importing this module (Issue
// #1479's import-safety guard) never touches argv or calls process.exit.
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--a', '--b', '--c', '--d'] as const;
type ArmFlag = (typeof ARM_FLAGS)[number];
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-auto-memory.ts [--a] [--b] [--c] [--d] [--expect-no-recall] [--expect-no-write]\n' +
  '  Default (no --a/--b/--c/--d) = all four arms, in order.\n' +
  '  --expect-no-recall modifies arm A (skip seeding); --expect-no-write modifies arm C (skip the remember-this prompt).\n' +
  '  Both flags only take effect when their arm is selected (explicitly, or by the all-four default).';

interface ParsedArgs {
  arms: Set<ArmFlag>;
  expectNoRecall: boolean;
  expectNoWrite: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const arms = new Set<ArmFlag>();
  let expectNoRecall = false;
  let expectNoWrite = false;
  for (const a of argv) {
    if ((ARM_FLAGS as readonly string[]).includes(a)) {
      arms.add(a as ArmFlag);
      continue;
    }
    if (a === '--expect-no-recall') {
      expectNoRecall = true;
      continue;
    }
    if (a === '--expect-no-write') {
      expectNoWrite = true;
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (arms.size === 0) for (const f of ARM_FLAGS) arms.add(f);
  return { arms, expectNoRecall, expectNoWrite };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
/** How long to wait for a write to land before reporting its absence. Used symmetrically for presence and absence checks -- an absence report carries the same detection budget as a presence report. */
const WRITE_POLL_TIMEOUT_MS = 60_000;
const WRITE_POLL_INTERVAL_MS = 3_000;
/** Shorter budget for Arm D's default-location leak check: by the time this runs, the override location has already been polled for the full budget above, so any genuine consolidation delay would have shown up there too. */
const LEAK_CHECK_TIMEOUT_MS = 10_000;
const LEAK_CHECK_INTERVAL_MS = 2_000;
/** How long to wait for the SDK to create a project-slug directory (transcript-driven, should be fast). */
const SLUG_DISCOVERY_TIMEOUT_MS = 10_000;
const SLUG_DISCOVERY_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** Mirrors `sdk-engine.ts`'s `buildOptions` pins for the fields this probe cares about. */
function buildOptions(cwd: string, settings: Partial<Settings>): Options {
  return {
    executable: 'bun',
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [],
    settings: { autoCompactEnabled: false, ...settings },
  };
}

function buildScratchCwd(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-sdk-automem-${label}-`));
  try {
    writeFileSync(join(dir, 'README.md'), 'auto-memory probe scratch\n');
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

class IsolationError extends Error {}

/** Runs `body` against a fresh isolated `CLAUDE_CONFIG_DIR`, verifies isolation held, and always tears the dir down. */
async function withArmConfigDir<T>(label: string, body: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = isolateClaudeConfigDir(label);
  try {
    const result = await body(configDir);
    const isolation = verifyIsolation(configDir);
    console.log(`${label}: child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`);
    if (!isolation.ok) {
      throw new IsolationError(
        `${label}: ISOLATION NOT VERIFIED -- the child wrote no state into the throwaway config dir; this arm cannot be trusted (it may have run against the operator's real config dir).`,
      );
    }
    return result;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function writeWorthyPrompt(fact: string): string {
  return (
    'Please remember this important fact for all future sessions on this project, so you can recall it later: ' +
    `${fact}. Retain this in your persistent memory.`
  );
}

function askAboutPrompt(subject: string): string {
  return (
    `Do you currently know ${subject}? If you can see it verbatim in your own context, state it exactly. ` +
    'If you do not know it, say exactly: UNKNOWN. Do not guess.'
  );
}

function recallsMentionNonce(recalls: readonly MemoryRecallMessage[], nonceValue: string, seededPath?: string): boolean {
  return recalls.some((r) => r.memories.some((m) => m.path === seededPath || (m.content?.includes(nonceValue) ?? false)));
}

/** One live SDK turn, logged and accounted for exactly like the sibling probes. */
async function runMemorySession(
  configDir: string,
  cwd: string,
  settings: Partial<Settings>,
  prompt: string,
  label: string,
  opts: { redactRecallLogging?: boolean } = {},
): Promise<{ outcome: TurnOutcome; recallsForTurn: MemoryRecallMessage[] }> {
  const options = buildOptions(cwd, settings);
  const s = new ProbeSession({ label, options, pollUsage: false });
  try {
    console.log(`${label} ready: ${await s.waitForReady()}`);
    const before = s.memoryRecalls.length;
    const outcome = await s.runTurn(prompt);
    account(label, outcome);
    console.log(turnLine(label, outcome));
    const unsettled = unsettledReason(outcome, label);
    if (unsettled) console.log(unsettled);
    const recallsForTurn = s.memoryRecalls.slice(before);
    if (recallsForTurn.length > 0) {
      const shown = opts.redactRecallLogging
        ? recallsForTurn.map((r) => ({ mode: r.mode, memories: r.memories.map((m) => redactRecallEntry(m, configDir)) }))
        : recallsForTurn.map((r) => ({ mode: r.mode, memories: r.memories.map((m) => ({ scope: m.scope, path: m.path })) }));
      console.log(`${label}: ${recallsForTurn.length} SDKMemoryRecallMessage(s) observed: ${JSON.stringify(shown)}`);
    }
    return { outcome, recallsForTurn };
  } finally {
    s.close();
    await s.waitForStreamEnd();
  }
}

function projectSlugs(configDir: string): string[] {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).filter((e) => {
    try {
      return statSync(join(projects, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

async function pollUntil<T>(check: () => T | null, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result !== null) return result;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** Waits for exactly one new project-slug directory to appear under an isolated, single-cwd config dir's `projects/`. */
async function discoverSlug(configDir: string): Promise<string | null> {
  return pollUntil(
    () => {
      const slugs = projectSlugs(configDir);
      if (slugs.length === 0) return null;
      if (slugs.length > 1) {
        console.log(`WARNING: multiple project slugs appeared under a single-cwd isolated config dir (${slugs.join(', ')}); using the first.`);
      }
      return slugs[0] ?? null;
    },
    SLUG_DISCOVERY_TIMEOUT_MS,
    SLUG_DISCOVERY_INTERVAL_MS,
  );
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir: boolean;
      let isFile: boolean;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (isFile) out.push(full);
    }
  }
  return out;
}

/**
 * Polls `baseDir` (recursively) for content. `matchText === null` means "any
 * file at all" (used for absence checks that do not care what was written);
 * otherwise "a file whose text includes matchText".
 */
async function pollForContent(
  baseDir: string,
  matchText: string | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ found: boolean; filePath?: string; elapsedMs: number }> {
  const start = Date.now();
  const result = await pollUntil(
    () => {
      const files = walkFiles(baseDir);
      if (matchText === null) return files.length > 0 ? files[0] : null;
      for (const f of files) {
        let text: string;
        try {
          text = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (text.includes(matchText)) return f;
      }
      return null;
    },
    timeoutMs,
    intervalMs,
  );
  return { found: result !== null && result !== undefined, filePath: result ?? undefined, elapsedMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Arm A -- recall
// ---------------------------------------------------------------------------

async function runArmA(expectNoRecall: boolean): Promise<ArmVerdict> {
  h(`Arm A -- Project-scoped recall (positive path + negative-control cwd)${expectNoRecall ? '  [--expect-no-recall]' : ''}`);
  return withArmConfigDir('automem-a', async (configDir) => {
    const cwdSeeded = buildScratchCwd('a-seeded');
    const cwdControl = buildScratchCwd('a-control');
    try {
      // Discovery: learn the SDK's own default memory directory for
      // cwdSeeded (see this file's header -- the algorithm cannot be read
      // from source, so it is discovered empirically). Uses a throwaway
      // fact, distinct from the real nonce measured below.
      const discoveryFact = nonce('AUTOMEM-A-DISCOVERY');
      const { outcome: discOutcome } = await runMemorySession(configDir, cwdSeeded, { autoMemoryEnabled: true }, writeWorthyPrompt(discoveryFact), 'A-discovery');
      if (!turnSettled(discOutcome)) {
        return { arm: 'A', ...inconclusive('the discovery turn did not settle.') };
      }
      const slug = await discoverSlug(configDir);
      if (slug === null) {
        return {
          arm: 'A',
          ...inconclusive('no project slug appeared under the isolated config dir after the discovery session -- cannot locate the default memory directory.'),
        };
      }
      const memoryDir = join(configDir, 'projects', slug, 'memory');
      console.log(`A: discovered default memory dir for this cwd: ${memoryDir}`);

      const theNonce = nonce('AUTOMEM-A');
      const seededPath = join(memoryDir, 'seeded-fact.md');
      if (!expectNoRecall) {
        mkdirSync(memoryDir, { recursive: true });
        writeFileSync(seededPath, `# Seeded fact\n\nThe secret project codename is ${theNonce}.\n`);
        console.log(`A: seeded nonce fact directly at ${seededPath}`);
      } else {
        console.log('A: [--expect-no-recall] skipping the seed step on purpose.');
      }

      const ask = askAboutPrompt('the secret project codename');
      const { outcome: measOutcome, recallsForTurn: measRecalls } = await runMemorySession(configDir, cwdSeeded, { autoMemoryEnabled: true }, ask, 'A-measure-seeded');
      const { outcome: ctrlOutcome, recallsForTurn: ctrlRecalls } = await runMemorySession(configDir, cwdControl, { autoMemoryEnabled: true }, ask, 'A-measure-control');

      const settled = turnSettled(measOutcome) && turnSettled(ctrlOutcome);
      const measRecallHit = recallsMentionNonce(measRecalls, theNonce, seededPath);
      const measTextHit = measOutcome.text.includes(theNonce);
      const ctrlRecallHit = recallsMentionNonce(ctrlRecalls, theNonce, seededPath);
      const ctrlTextHit = ctrlOutcome.text.includes(theNonce);
      console.log(`A: measSeeded recall=${measRecallHit} text=${measTextHit}; control recall=${ctrlRecallHit} text=${ctrlTextHit}`);

      return { arm: 'A', ...classifyArmA({ settled, expectNoRecall, measRecallHit, measTextHit, ctrlRecallHit, ctrlTextHit }) };
    } finally {
      rmSync(cwdSeeded, { recursive: true, force: true });
      rmSync(cwdControl, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm B -- leak (re-derive #1348)
// ---------------------------------------------------------------------------

async function runArmB(): Promise<ArmVerdict> {
  h('Arm B -- re-derive #1348 under controlled conditions (unseeded cwd)');
  return withArmConfigDir('automem-b', async (configDir) => {
    const cwdB = buildScratchCwd('b');
    try {
      const prompt =
        'Before we begin: do you already know anything about me, my preferences, or this project from previous ' +
        'sessions or from your own memory? If so, tell me everything you recall, as specifically as you can. ' +
        'If not, say exactly: UNKNOWN.';
      const { outcome, recallsForTurn } = await runMemorySession(configDir, cwdB, { autoMemoryEnabled: true }, prompt, 'B', {
        redactRecallLogging: true,
      });
      if (!turnSettled(outcome)) {
        return { arm: 'B', ...inconclusive('the turn did not settle.') };
      }
      const summaries = recallsForTurn.flatMap((r) => r.memories.map((m) => ({ mode: r.mode, ...redactRecallEntry(m, configDir) })));
      console.log(`B: ${summaries.length} memori(es) surfaced for an UNSEEDED cwd: ${JSON.stringify(summaries)}`);
      return {
        arm: 'B',
        conclusive: true,
        premise: null,
        note:
          summaries.length > 0
            ? `LEAK: ${summaries.length} memori(es) surfaced for a cwd with nothing seeded at its own Project-scope path. Scopes observed: ${summaries.map((s) => s.scope).join(', ')}. Content is never logged; see the printed summaries above for whether each was within this run's own isolated config dir (scratch data) or not (a leak from elsewhere).`
            : 'NO LEAK: nothing surfaced for an unseeded cwd in this run.',
      };
    } finally {
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm C -- write
// ---------------------------------------------------------------------------

async function runArmC(expectNoWrite: boolean): Promise<ArmVerdict> {
  h(`Arm C -- does auto-memory write work in this headless config?${expectNoWrite ? '  [--expect-no-write]' : ''}`);
  return withArmConfigDir('automem-c', async (configDir) => {
    const cwdC = buildScratchCwd('c');
    try {
      const theNonce = nonce('AUTOMEM-C');
      const prompt = expectNoWrite ? 'What is 2 + 2? Answer with just the number, nothing else.' : writeWorthyPrompt(theNonce);
      const { outcome } = await runMemorySession(configDir, cwdC, { autoMemoryEnabled: true }, prompt, 'C');
      if (!turnSettled(outcome)) {
        return { arm: 'C', ...inconclusive('the turn did not settle.') };
      }
      const slug = await discoverSlug(configDir);
      if (slug === null) {
        return {
          arm: 'C',
          ...classifyArmC({ settled: true, slugFound: false, expectNoWrite, contentFound: false, elapsedMs: 0, timeoutMs: WRITE_POLL_TIMEOUT_MS }),
        };
      }
      const memoryDir = join(configDir, 'projects', slug, 'memory');
      const poll = await pollForContent(memoryDir, expectNoWrite ? null : theNonce, WRITE_POLL_TIMEOUT_MS, WRITE_POLL_INTERVAL_MS);
      console.log(`C: polled ${memoryDir} for up to ${WRITE_POLL_TIMEOUT_MS}ms -- found=${poll.found} elapsed=${poll.elapsedMs}ms file=${poll.filePath ?? '(none)'}`);
      return {
        arm: 'C',
        ...classifyArmC({
          settled: true,
          slugFound: true,
          expectNoWrite,
          contentFound: poll.found,
          filePath: poll.filePath,
          elapsedMs: poll.elapsedMs,
          timeoutMs: WRITE_POLL_TIMEOUT_MS,
        }),
      };
    } finally {
      rmSync(cwdC, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm D -- redirect
// ---------------------------------------------------------------------------

async function runArmDRead(): Promise<ArmDReadMeasurement> {
  return withArmConfigDir('automem-d-read', async (configDir) => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-d-read-override-'));
    const cwd = buildScratchCwd('d-read');
    try {
      const readNonce = nonce('AUTOMEM-D-READ');
      const seedPath = join(overrideDir, 'seed.md');
      writeFileSync(seedPath, `# Seeded fact\n\nThe override codename is ${readNonce}.\n`);
      const { outcome, recallsForTurn } = await runMemorySession(
        configDir,
        cwd,
        { autoMemoryEnabled: true, autoMemoryDirectory: overrideDir },
        askAboutPrompt('the override codename'),
        'D-read',
      );
      return {
        settled: turnSettled(outcome),
        recallHit: recallsMentionNonce(recallsForTurn, readNonce, seedPath),
        textHit: outcome.text.includes(readNonce),
      };
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function runArmDWrite(): Promise<ArmDWriteMeasurement> {
  return withArmConfigDir('automem-d-write', async (configDir) => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-d-write-override-'));
    const cwd = buildScratchCwd('d-write');
    try {
      const writeNonce = nonce('AUTOMEM-D-WRITE');
      const { outcome } = await runMemorySession(configDir, cwd, { autoMemoryEnabled: true, autoMemoryDirectory: overrideDir }, writeWorthyPrompt(writeNonce), 'D-write');
      if (!turnSettled(outcome)) {
        return { settled: false, writeFound: false, defaultLeaked: false };
      }
      const overridePoll = await pollForContent(overrideDir, writeNonce, WRITE_POLL_TIMEOUT_MS, WRITE_POLL_INTERVAL_MS);
      console.log(`D-write: override dir ${overrideDir} -- found=${overridePoll.found} elapsed=${overridePoll.elapsedMs}ms`);
      const defaultSlug = await discoverSlug(configDir);
      let defaultLeaked = false;
      if (defaultSlug !== null) {
        const defaultMemoryDir = join(configDir, 'projects', defaultSlug, 'memory');
        const defaultPoll = await pollForContent(defaultMemoryDir, null, LEAK_CHECK_TIMEOUT_MS, LEAK_CHECK_INTERVAL_MS);
        defaultLeaked = defaultPoll.found;
        console.log(`D-write: default-location leak check (${defaultMemoryDir}) -- found=${defaultPoll.found}`);
      }
      return { settled: true, writeFound: overridePoll.found, writeFilePath: overridePoll.filePath, defaultLeaked };
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function runArmD(): Promise<ArmVerdict> {
  h('Arm D -- can autoMemoryDirectory be redirected deliberately? (read half + write half)');
  const read = await runArmDRead();
  const write = await runArmDWrite();
  return { arm: 'D', ...classifyArmD({ read, write }) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const selected = parseArgs(process.argv.slice(2));

  console.log(`probe-sdk-auto-memory  started ${stamp()}`);
  console.log(`arms: ${[...selected.arms].join(' ')}${selected.expectNoRecall ? ' --expect-no-recall' : ''}${selected.expectNoWrite ? ' --expect-no-write' : ''}`);
  console.log(`model: ${MODEL}`);

  const sdkPackageJson = await Bun.file(
    join(import.meta.dir, '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
  ).json();
  console.log(`@anthropic-ai/claude-agent-sdk version: ${sdkPackageJson.version}`);

  const results: ArmVerdict[] = [];
  if (selected.arms.has('--a')) results.push(await runArmA(selected.expectNoRecall));
  if (selected.arms.has('--b')) results.push(await runArmB());
  if (selected.arms.has('--c')) results.push(await runArmC(selected.expectNoWrite));
  if (selected.arms.has('--d')) results.push(await runArmD());

  h('Verdict');
  for (const r of results) {
    console.log(`Arm ${r.arm}: ${r.note}`);
  }

  h('Which of the four premises hold');
  const byArm = new Map(results.map((r) => [r.arm, r]));
  const holds = (arm: ArmVerdict['arm']) => byArm.get(arm)?.premise === 'holds';
  console.log(`recall works (A):        ${byArm.has('A') ? holds('A') : '(not run)'}`);
  console.log(`leak scope identified (B): ${byArm.has('B') ? (byArm.get('B')!.note.startsWith('LEAK') ? 'yes -- see scopes above' : 'no leak observed') : '(not run)'}`);
  console.log(`write works (C):         ${byArm.has('C') ? holds('C') : '(not run)'}`);
  console.log(`redirect works (D):      ${byArm.has('D') ? holds('D') : '(not run)'}`);

  const code = exitCodeFor(results);
  console.log(`\nexit code ${code} -- ${EXIT_CODE_MEANINGS[code]}`);

  const t = totals();
  console.log(`\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`);

  return code;
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('probe could not run:', err);
      process.exit(PROBE_EXIT.HARNESS);
    });
}
