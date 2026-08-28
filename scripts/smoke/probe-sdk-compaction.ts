#!/usr/bin/env bun
/**
 * Live probe for the compaction premises behind the handoff -> compaction
 * swap (Issue #1400; docs/design/embedded-agent-sdk-engine.md §5's PS1/PS2).
 * Measurement only -- this script changes no production behavior and is not
 * wired into CI.
 *
 * The items, and what each one settles:
 *
 *   --p1a   Does the `autoCompactEnabled` SETTING ARRIVE? Construct with
 *           `false` and with `true`, flip each mid-session via
 *           `applyFlagSettings`, and read `getContextUsage()`'s
 *           `isAutoCompactEnabled` back each time. Our engine WRITES
 *           `settings.autoCompactEnabled` while the SDK's response READS
 *           `isAutoCompactEnabled`; if those two names do not refer to the
 *           same switch, the OFF setting has been a no-op all along.
 *           NOTE what this item is NOT: a read-back is not proof of
 *           behavior. P3 is the separate layer that checks whether behavior
 *           follows the setting.
 *   --p1b   Folded into --p1a: the default `autoCompactThreshold` is
 *           recorded from the same responses (read side only).
 *   --p3i   Is the threshold/window WRITABLE? Cheap, and split out from the
 *           expensive --p3-on so the answer can be had without paying for a
 *           full drive (an addition to #1400's flag list, not a change to
 *           it). Tries `autoCompactThreshold` and `autoCompactWindow` at
 *           construction, via `applyFlagSettings`, and via the `/autocompact`
 *           slash command -- three genuinely different write paths that do
 *           NOT behave the same way. It also tries a deliberately
 *           BELOW-FLOOR window value, because that is what makes the
 *           difference between "the key does nothing" and "the key rejected
 *           my value" visible.
 *   --p2    Does `/compact` EXIST as a user-sendable command over streaming
 *           input? Records the full `supportedCommands()` list, builds a
 *           conversation long enough to actually be compactable, sends
 *           `/compact`, and reports every message type that arrived through
 *           the query iterator. Both "it works" and "it does not work" are
 *           results; only "indeterminate" is a failure.
 *   --p3-on What auto-ON actually DOES: with `autoCompactEnabled: true` and
 *           the shrunken window from --p3i, drive context past the threshold
 *           and record the firing signal, the usage delta across it, and
 *           recall of a nonce planted before the boundary.
 *   --p3-neg The same pressure with `autoCompactEnabled: false`. Its control
 *           is --p3-on, run in the SAME invocation (`--p3-on --p3-neg`) so
 *           the pairing #1400 requires holds within one run.
 *   --p4-hooks Can `PreCompact`/`PostCompact` be wired, and does
 *           `compact_summary` arrive? Opportunistic: not being able to wire
 *           them is a recorded non-result, not a failure.
 *
 * Default (no item flags) = the cheap `--p1a --p3i --p2` set.
 *
 * POSITIVE CONTROLS. Every negative conclusion this script can reach is
 * paired with a positive control taken in the SAME run and the SAME commit,
 * so "nothing happened" can be told apart from "the harness was dead":
 *   CTRL-P1A-FLIP  `applyFlagSettings` demonstrably moves `autoCompactEnabled`
 *                  in BOTH directions on the same control channel. Any P3(i)
 *                  "this key did not move" rests on it.
 *   CTRL-P3I-FLOOR a below-floor window value is REJECTED WITH A MESSAGE
 *                  while an at-floor value is ACCEPTED, in the same session
 *                  -- so "the window did not move" is never reported without
 *                  showing the value that does move it.
 *   CTRL-P2-TURN   normal turns complete on the /compact session before and
 *                  after the attempt.
 *   CTRL-P3-ON     item (ii) reaching a real boundary under the same lever
 *                  and pressure schedule that (iii) reports no boundary for.
 *
 * METHODOLOGY: see `probe-sdk-session-harness.ts`'s header -- production
 * `spawnClaudeCodeProcess`/`UserMessageQueue`, a `for await` loop that never
 * breaks early (`probe-sdk-h2-transport-settle-negative-control.ts` is the
 * canonical account of why), and usage polls issued from inside that live
 * loop body.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user, and `bun install` already run so
 * `@anthropic-ai/claude-agent-sdk` resolves to the version under test. This
 * makes real Anthropic API calls and costs real usage -- a manual tool, run
 * by hand when re-verifying the design doc's version-premised behavior, NOT
 * a CI gate (hence no `check:` alias).
 *
 * Usage: the invocation line is NOT restated here. `USAGE_TEXT` below is its
 * single writer -- the script prints it on any usage error, and the flag
 * lists it names (`ITEM_FLAGS`, `VALUE_FLAGS`) are the same constants the
 * parser reads. This header used to carry its own copy, and the two drifted:
 * the header still advertised `--budget-tokens` after the flag had been
 * renamed to `--budget-usd`, so the one artifact a future operator reads
 * before running the script was the one telling them the wrong thing.
 *
 * Exit codes:
 *   0  every selected item produced a determinate result (which may be a
 *      negative one -- "the SDK does not do X" is a result, not a failure)
 *   1  at least one selected item hit a STOP condition (#1400): a key/shape
 *      mismatch in --p1a, an indeterminate --p2, or a --p3-on that could not
 *      reach a boundary inside the budget. STOP means consult before
 *      changing any design -- it does not mean the script malfunctioned.
 *   2  bad usage / probe could not run (unrecognized argument, no `claude`
 *      auth, or the CLAUDE_CONFIG_DIR isolation could not be verified) --
 *      argument validation happens before anything billable runs, so a typo
 *      never silently burns API usage.
 */

import type { Options, Settings } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
  filler,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  unsettledReason,
  usageLine,
  verifyIsolation,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

// ---------------------------------------------------------------------------
// Argument parsing -- BEFORE anything billable runs.
// ---------------------------------------------------------------------------

const ITEM_FLAGS = ['--p1a', '--p3i', '--p2', '--p3-on', '--p3-neg', '--p4-hooks'] as const;
const VALUE_FLAGS = ['--budget-usd', '--budget-minutes'] as const;

const argv = process.argv.slice(2);
const selected = new Set<string>();
/**
 * The pressure items' spend ceiling, in DOLLARS, not tokens. #1400 first
 * expressed it as "~200k cumulative prompt tokens" and this probe's own
 * measurement retired that unit: `modelUsage` counts cache reads, and a
 * streaming session re-reads its whole context every turn, so the CHEAPEST
 * item set alone crosses 200k while costing $0.17. A token ceiling on that
 * figure stops the probe at its cheapest item and never at an expensive one.
 * Cumulative tokens are still recorded -- they are just not the gate.
 * (Owner decision, 2026-08-28, on this probe's own mid-run report.)
 */
let budgetUsd = 2;
let budgetMinutes = 30;
const USAGE_TEXT = `Usage: bun scripts/smoke/probe-sdk-compaction.ts [--p1a] [--p3i] [--p2] [--p3-on] [--p3-neg] [--p4-hooks] [--budget-usd N] [--budget-minutes N]
  Default (no item flag) = --p1a --p3i --p2 (the cheap set).`;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if ((ITEM_FLAGS as readonly string[]).includes(a)) {
    selected.add(a);
    continue;
  }
  if ((VALUE_FLAGS as readonly string[]).includes(a)) {
    const raw = argv[++i];
    if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
      console.error(`${USAGE_TEXT}\n  ${a} requires a positive integer. Got: ${raw ?? '(nothing)'}`);
      process.exit(2);
    }
    if (a === '--budget-usd') budgetUsd = Number(raw);
    else budgetMinutes = Number(raw);
    continue;
  }
  console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
  process.exit(2);
}

if (selected.size === 0) {
  selected.add('--p1a');
  selected.add('--p3i');
  selected.add('--p2');
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';

/**
 * The window the P3 items shrink the auto-compaction budget to, and the
 * value --p3i probes the write paths with. 100,000 is not a round number
 * picked for taste: it is the SDK's own documented FLOOR. `/autocompact`
 * rejects anything outside "auto or 100k-1M tokens" with an explicit parse
 * message, and -- this is the part that matters for reading PS2 -- a
 * `settings.autoCompactWindow` BELOW that floor is dropped SILENTLY, with no
 * error and no change to `getContextUsage()`. A probe that tried a small
 * number and concluded "the key has no effect" would be describing the floor,
 * not the key. `BELOW_FLOOR_WINDOW` exists to keep that distinction visible
 * in this script's own output.
 */
const PROBE_WINDOW = 100_000;
const BELOW_FLOOR_WINDOW = 30_000;

/**
 * `autoCompactThreshold` is NOT a key of the SDK's `Settings` type -- only
 * `autoCompactWindow` is. P3(i) measures whether the runtime accepts it
 * anyway, so the probe has to be able to send it. Declaring the extra key
 * keeps "this key is untyped, and that is the thing under test" visible in
 * the type, rather than erasing the whole shape behind a cast.
 */
type ProbeSettings = Settings & { autoCompactThreshold?: number };

const CONFIG_DIR = isolateClaudeConfigDir('compaction');
const startedAt = Date.now();

/**
 * `modelUsage` and `total_cost_usd` are CUMULATIVE per `query()` call, so a
 * session's latest result already carries its own running total -- summing
 * turn over turn would multiply-count. Sum ACROSS sessions instead, keyed by
 * the session label, taking each session's latest figure.
 */
const perSession = new Map<string, { tokens: number; freshTokens: number; cost: number }>();

/**
 * Cumulative prompt tokens INCLUDING cache reads -- the figure #1400's budget
 * ceiling is expressed in, and the one the budget guard enforces. It grows
 * fast for a reason that is not extra spend: every turn of a streaming
 * session re-reads the whole context, so a long conversation re-counts the
 * same tokens each turn at cache-read rates.
 */
function totalPromptTokens(): number {
  let t = 0;
  for (const v of perSession.values()) t += v.tokens;
  return t;
}
/** The same figure with cache reads excluded -- tokens genuinely sent fresh. */
function totalFreshPromptTokens(): number {
  let t = 0;
  for (const v of perSession.values()) t += v.freshTokens;
  return t;
}
function totalCostUsd(): number {
  let c = 0;
  for (const v of perSession.values()) c += v.cost;
  return c;
}

/**
 * Mirrors `sdk-engine.ts`'s `buildOptions` pins that matter here
 * (`executable: 'bun'`, `settingSources: []`, production
 * `spawnClaudeCodeProcess` -- injected by the harness -- and an explicit
 * `settings` object). `mcpServers` is omitted: no agent-console server is
 * running for a bare probe, and none of #1400's items involve MCP.
 */
function buildOptions(settings: Settings, tools?: string[]): Options {
  return {
    executable: 'bun',
    cwd: process.cwd(),
    model: MODEL,
    ...(tools ? { tools } : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [],
    settings,
  };
}

function accountTurn(label: string, outcome: TurnOutcome): void {
  const r = outcome.result;
  if (!r) return;
  let prompt = 0;
  let fresh = 0;
  for (const mu of Object.values(r.modelUsage ?? {})) {
    fresh += (mu.inputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
    prompt += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
  }
  perSession.set(label, { tokens: prompt, freshTokens: fresh, cost: r.total_cost_usd ?? 0 });
}

function budgetExceeded(): string | null {
  const minutes = (Date.now() - startedAt) / 60_000;
  if (totalCostUsd() > budgetUsd) {
    return `estimated cost $${totalCostUsd().toFixed(4)} > budget $${budgetUsd}`;
  }
  if (minutes > budgetMinutes) {
    return `elapsed ${minutes.toFixed(1)} min > budget ${budgetMinutes} min`;
  }
  return null;
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

// ---------------------------------------------------------------------------
// P1a (+ P1b): does the setting arrive?
// ---------------------------------------------------------------------------

async function readIsAutoCompactEnabled(s: ProbeSession, when: string): Promise<boolean | 'absent' | 'error'> {
  try {
    const u = await s.readUsage();
    console.log(`  ${when}: ${usageLine(u)}`);
    if (!('isAutoCompactEnabled' in u)) return 'absent';
    return u.isAutoCompactEnabled;
  } catch (err) {
    console.log(`  ${when}: getContextUsage() FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

async function itemP1a(): Promise<void> {
  h('P1a / P1b -- does `autoCompactEnabled` arrive, and what is the default threshold?');

  const findings: string[] = [];
  let mismatch = false;

  // -- Session A: constructed OFF, flipped ON mid-session.
  const a = new ProbeSession({ label: 'p1a-off', options: buildOptions({ autoCompactEnabled: false }) });
  console.log(`session A (constructed autoCompactEnabled:false) ready-via=${await a.waitForReady()}`);
  const aConstructed = await readIsAutoCompactEnabled(a, 'A after construct(false)');
  findings.push(`construct(false) -> isAutoCompactEnabled=${aConstructed}`);
  if (aConstructed !== false) mismatch = true;

  // CTRL-P1A-FLIP: the mid-session write channel demonstrably moves this key.
  await a.q.applyFlagSettings({ autoCompactEnabled: true });
  const aFlipped = await readIsAutoCompactEnabled(a, 'A after applyFlagSettings(true)');
  findings.push(`applyFlagSettings(true) -> isAutoCompactEnabled=${aFlipped}`);
  if (aFlipped !== true) mismatch = true;
  a.close();
  await a.waitForStreamEnd();

  // -- Session B: the symmetric case, constructed ON, flipped OFF.
  const b = new ProbeSession({ label: 'p1a-on', options: buildOptions({ autoCompactEnabled: true }) });
  console.log(`session B (constructed autoCompactEnabled:true) ready-via=${await b.waitForReady()}`);
  const bConstructed = await readIsAutoCompactEnabled(b, 'B after construct(true)');
  findings.push(`construct(true) -> isAutoCompactEnabled=${bConstructed}`);
  if (bConstructed !== true) mismatch = true;

  await b.q.applyFlagSettings({ autoCompactEnabled: false });
  const bFlipped = await readIsAutoCompactEnabled(b, 'B after applyFlagSettings(false)');
  findings.push(`applyFlagSettings(false) -> isAutoCompactEnabled=${bFlipped}`);
  if (bFlipped !== false) mismatch = true;
  b.close();
  await b.waitForStreamEnd();

  console.log('\nP1a findings:');
  for (const f of findings) console.log(`  - ${f}`);
  console.log(
    '\nP1b (read side, same responses): the default `autoCompactThreshold` is reported ONLY while auto-compaction is on;\n' +
      'with it off the field is absent and `maxTokens` reverts to the full window. Exact figures are in the lines above.',
  );

  verdicts.push({
    item: 'P1a (setting arrives)',
    verdict: mismatch
      ? 'STOP -- key/shape mismatch: the read-back does not follow the setting'
      : 'PASS -- the write key `settings.autoCompactEnabled` and the read key `isAutoCompactEnabled` name the same switch, at construction AND mid-session. A second, independent signal moves with it: `autoCompactThreshold`/`maxTokens` appear and shrink when it is on, and revert when it is off',
    stop: mismatch,
    control: 'CTRL-P1A-FLIP (both directions moved on the same channel; a stuck value could not have produced both)',
  });
  verdicts.push({
    item: 'P1a -> live-toggle-reflection gate',
    verdict: mismatch
      ? 'NOT ESTABLISHED (P1a did not pass)'
      : "PASS -- `applyFlagSettings` reflection is exactly what the mid-session half of P1a exercised, so the implementation PR's live per-worker toggle is unblocked by this item",
    stop: false,
    control: 'same as P1a',
  });
}

// ---------------------------------------------------------------------------
// P3(i): is the threshold / window writable?
// ---------------------------------------------------------------------------

function usageDigest(u: { autoCompactThreshold?: number; maxTokens: number; rawMaxTokens: number }): string {
  return `threshold=${u.autoCompactThreshold ?? '(absent)'} maxTokens=${u.maxTokens} rawMaxTokens=${u.rawMaxTokens}`;
}

interface WriteAttempt {
  how: string;
  before: string;
  after: string;
  moved: boolean;
  reply?: string;
  error?: string;
  /**
   * Set when the write's own turn never settled. `moved` is then MEANINGLESS
   * -- the write may never have reached the CLI -- so the verdict must not
   * read it as "this key does nothing".
   */
  unsettled?: string;
}

async function applyAttempt(
  s: ProbeSession,
  how: string,
  write: () => Promise<{ reply?: string; unsettled?: string }>,
): Promise<WriteAttempt> {
  const before = usageDigest(await s.readUsage());
  let error: string | undefined;
  let reply: string | undefined;
  let unsettled: string | undefined;
  try {
    const out = await write();
    reply = out.reply;
    unsettled = out.unsettled;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const after = usageDigest(await s.readUsage());
  return { how, before, after, moved: before !== after && !unsettled, reply, error, unsettled };
}

/** P3(i) result: the cheapest write path that actually moves the window, if any. */
interface Lever {
  kind: 'construct-window' | 'slash-autocompact' | null;
  window: number;
  /**
   * Whether the SAME window can be given to an `autoCompactEnabled: false`
   * session -- which decides whether P3(iii) is a one-variable experiment or
   * no experiment at all. If turning compaction off also discards the window,
   * the OFF arm necessarily runs against the model's full window, and its
   * "no compaction occurred" is fully explained by the window alone, with
   * nothing left over to attribute to the flag. That is the same
   * unfalsifiability shape #1400 was written to eliminate, one level up: not
   * "the context was too small to compact" but "the window was too large to
   * compact at". `offArmLever` names the path that works, or null.
   */
  offArmLever: 'construct-window' | 'slash-autocompact' | null;
}

async function itemP3i(): Promise<Lever> {
  h('P3(i) -- is the auto-compaction threshold / window WRITABLE?');
  const attempts: WriteAttempt[] = [];

  const s = new ProbeSession({ label: 'p3i', options: buildOptions({ autoCompactEnabled: true }) });
  await s.waitForReady();
  const baseline = usageDigest(await s.readUsage());
  console.log(`baseline (autoCompactEnabled:true, no lever written): ${baseline}`);

  attempts.push(
    await applyAttempt(s, 'applyFlagSettings({autoCompactThreshold: 0.2})', async () => {
      const probe: ProbeSettings = { autoCompactThreshold: 0.2 };
      await s.q.applyFlagSettings(probe);
      return {};
    }),
  );
  attempts.push(
    await applyAttempt(s, `applyFlagSettings({autoCompactWindow: ${PROBE_WINDOW}})`, async () => {
      await s.q.applyFlagSettings({ autoCompactWindow: PROBE_WINDOW });
      return {};
    }),
  );

  // CTRL-P3I-FLOOR: the below-floor value is refused WITH A MESSAGE while the
  // at-floor value is accepted, in this same session -- the pairing that
  // separates "this key does nothing" from "this key rejected my value".
  attempts.push(
    await applyAttempt(s, `/autocompact ${BELOW_FLOOR_WINDOW} (deliberately below the SDK's floor)`, async () => {
      const t = await s.runTurn(`/autocompact ${BELOW_FLOOR_WINDOW}`);
      accountTurn('p3i', t);
      console.log(`  ${turnLine('/autocompact below-floor turn', t)}`);
      return { reply: t.text.trim(), unsettled: unsettledReason(t, 'the below-floor /autocompact turn') ?? undefined };
    }),
  );
  attempts.push(
    await applyAttempt(s, `/autocompact ${PROBE_WINDOW / 1000}k`, async () => {
      const t = await s.runTurn(`/autocompact ${PROBE_WINDOW / 1000}k`);
      accountTurn('p3i', t);
      console.log(`  ${turnLine('/autocompact at-floor turn', t)}`);
      return { reply: t.text.trim(), unsettled: unsettledReason(t, 'the at-floor /autocompact turn') ?? undefined };
    }),
  );
  s.close();
  await s.waitForStreamEnd();

  // Construction-time is a genuinely different write path from the
  // mid-session control request, so it is measured separately.
  const c = new ProbeSession({
    label: 'p3i-construct-window',
    options: buildOptions({ autoCompactEnabled: true, autoCompactWindow: PROBE_WINDOW }),
  });
  await c.waitForReady();
  const constructedWindow = usageDigest(await c.readUsage());
  c.close();
  await c.waitForStreamEnd();

  const cLow = new ProbeSession({
    label: 'p3i-construct-window-below-floor',
    options: buildOptions({ autoCompactEnabled: true, autoCompactWindow: BELOW_FLOOR_WINDOW }),
  });
  await cLow.waitForReady();
  const constructedBelowFloor = usageDigest(await cLow.readUsage());
  cLow.close();
  await cLow.waitForStreamEnd();

  const d = new ProbeSession({
    label: 'p3i-construct-threshold',
    options: buildOptions({ autoCompactEnabled: true, autoCompactThreshold: 0.2 } satisfies ProbeSettings),
  });
  await d.waitForReady();
  const constructedThreshold = usageDigest(await d.readUsage());
  d.close();
  await d.waitForStreamEnd();

  console.log('\nP3(i) write paths:');
  for (const a of attempts) {
    console.log(`  ${a.how}`);
    console.log(`    before: ${a.before}`);
    console.log(`    after : ${a.after}   moved=${a.moved}`);
    if (a.reply) console.log(`    reply : ${JSON.stringify(a.reply.slice(0, 240))}`);
    if (a.error) console.log(`    error : ${a.error}`);
    if (a.unsettled) console.log(`    NO MEASUREMENT: ${a.unsettled}`);
  }
  console.log(`  baseline (no lever)                                  -> ${baseline}`);
  console.log(`  construct({autoCompactWindow: ${PROBE_WINDOW}})            -> ${constructedWindow}   moved=${constructedWindow !== baseline}`);
  console.log(`  construct({autoCompactWindow: ${BELOW_FLOOR_WINDOW}}) [below floor] -> ${constructedBelowFloor}   moved=${constructedBelowFloor !== baseline}`);
  console.log(`  construct({autoCompactThreshold: 0.2})               -> ${constructedThreshold}   moved=${constructedThreshold !== baseline}`);

  const constructWindowWorks = constructedWindow !== baseline;
  const slashWorks = attempts.find((a) => a.how.includes(`${PROBE_WINDOW / 1000}k`))?.moved === true;
  const applyFlagWindowWorks = attempts.find((a) => a.how.includes('applyFlagSettings({autoCompactWindow'))?.moved === true;
  const thresholdWorks =
    attempts.find((a) => a.how.includes('autoCompactThreshold'))?.moved === true || constructedThreshold !== baseline;

  // -- Can the OFF arm be given the same window? (The P3(iii) prerequisite.)
  const offConstruct = new ProbeSession({
    label: 'p3i-off-construct-window',
    options: buildOptions({ autoCompactEnabled: false, autoCompactWindow: PROBE_WINDOW }),
  });
  await offConstruct.waitForReady();
  const offConstructUsage = await offConstruct.readUsage();
  offConstruct.close();
  await offConstruct.waitForStreamEnd();

  const offSlash = new ProbeSession({
    label: 'p3i-off-slash',
    options: buildOptions({ autoCompactEnabled: false }),
  });
  await offSlash.waitForReady();
  const offSlashTurn = await offSlash.runTurn(`/autocompact ${PROBE_WINDOW / 1000}k`);
  accountTurn('p3i-off-slash', offSlashTurn);
  const offSlashUsage = await offSlash.readUsage();
  offSlash.close();
  await offSlash.waitForStreamEnd();

  console.log('\nP3(iii) prerequisite -- can an `autoCompactEnabled: false` session be given the same window?');
  console.log(`  construct({autoCompactEnabled:false, autoCompactWindow:${PROBE_WINDOW}}) -> ${usageLine(offConstructUsage)}`);
  console.log(`  flag:false then /autocompact ${PROBE_WINDOW / 1000}k -> reply ${JSON.stringify(offSlashTurn.text.trim().slice(0, 200))}`);
  console.log(`    read back: ${usageLine(offSlashUsage)}`);

  // The window counts as applied to the OFF arm only if it is reflected AND
  // compaction is still off -- a path that silently re-enables compaction
  // would swap one confound for another.
  const offConstructApplies = offConstructUsage.maxTokens === PROBE_WINDOW && offConstructUsage.isAutoCompactEnabled === false;
  const offSlashApplies = offSlashUsage.maxTokens === PROBE_WINDOW && offSlashUsage.isAutoCompactEnabled === false;
  console.log(
    `  -> OFF-arm window applicable: construct=${offConstructApplies} slash=${offSlashApplies}` +
      `${offSlashUsage.isAutoCompactEnabled ? ' (NOTE: the slash path also switched compaction back ON -- unusable as an OFF-arm lever)' : ''}`,
  );

  const lever: Lever = {
    kind: constructWindowWorks ? 'construct-window' : slashWorks ? 'slash-autocompact' : null,
    window: PROBE_WINDOW,
    offArmLever: offConstructApplies ? 'construct-window' : offSlashApplies ? 'slash-autocompact' : null,
  };

  verdicts.push({
    item: 'P3(iii) prerequisite (can the OFF arm get the same window?)',
    verdict: lever.offArmLever
      ? `YES via \`${lever.offArmLever}\` -- an \`autoCompactEnabled: false\` session reports maxTokens=${PROBE_WINDOW} with compaction still off, so P3(iii) can be run as a ONE-variable experiment against P3(ii)`
      : `NO -- turning compaction off discards the window too (construct: ${usageDigest(offConstructUsage)}; /autocompact under flag:false: ${usageDigest(offSlashUsage)}). P3(iii) therefore CANNOT be run as a one-variable experiment at any budget: the OFF arm is stuck at the model's full window, where the threshold is ~934000, and a run that stops short of that proves nothing about the flag`,
    stop: false,
    control:
      'the ON arm reporting maxTokens=' + PROBE_WINDOW + ' from the same construction path in the same run -- so a null result here is the flag discarding the window, not the window write failing',
  });

  const parts: string[] = [];
  parts.push(
    `\`settings.autoCompactWindow\` at CONSTRUCTION: ${constructWindowWorks ? 'WRITABLE' : 'no effect'}`,
    `\`applyFlagSettings({autoCompactWindow})\` mid-session: ${applyFlagWindowWorks ? 'WRITABLE' : 'NO EFFECT'}`,
    `\`/autocompact <n>\` as a user message: ${slashWorks ? 'WRITABLE' : 'no effect'}`,
    `\`autoCompactThreshold\` (not a Settings key): ${thresholdWorks ? 'WRITABLE' : 'no effect, at either path'}`,
    `the window has a FLOOR: a below-floor value is refused by \`/autocompact\` with a parse message and dropped SILENTLY by \`settings.autoCompactWindow\``,
  );

  const unmeasured = attempts.filter((a) => a.unsettled);
  if (unmeasured.length > 0) {
    parts.push(
      `**${unmeasured.length} write path(s) produced NO MEASUREMENT** (${unmeasured.map((a) => a.how).join('; ')}) -- those are not negative results and must not be read as one`,
    );
  }
  verdicts.push({
    item: 'P3(i) (threshold/window writable)',
    verdict: `${lever.kind ? 'PARTIALLY WRITABLE' : 'NOT WRITABLE'} -- ${parts.join('; ')}`,
    stop: false,
    control:
      'CTRL-P3I-FLOOR (an at-floor value moves the same read side a below-floor value leaves untouched, in the same session) + CTRL-P1A-FLIP (the `applyFlagSettings` channel demonstrably moves `autoCompactEnabled` in this same commit, so "nothing moved" is not a dead control channel)',
  });
  return lever;
}

// ---------------------------------------------------------------------------
// P2: does `/compact` exist and work over streaming input?
// ---------------------------------------------------------------------------

/** `/compact` refuses a conversation it considers too short; give it one. */
const P2_WARMUP_TURNS = 5;

async function itemP2(): Promise<void> {
  h('P2 -- does `/compact` reach us as a `compact_boundary` through the query iterator?');

  // Production's own pin: compaction OFF. If `/compact` works here, it works
  // in exactly the configuration the implementation PR would ship it under.
  const s = new ProbeSession({ label: 'p2', options: buildOptions({ autoCompactEnabled: false }) });
  await s.waitForReady();

  const commands = await s.q.supportedCommands();
  console.log(`supportedCommands() -> ${commands.length} commands (names only; full descriptions are long):`);
  console.log(`  ${commands.map((c) => `/${c.name}`).join(' ')}`);
  const compactCommand = commands.find((c) => c.name === 'compact' || c.aliases?.includes('compact'));
  console.log(`\n/compact present in supportedCommands(): ${compactCommand ? `YES -- ${JSON.stringify(compactCommand)}` : 'NO'}`);

  const token = nonce('NONCE-P2');
  // CTRL-P2-TURN (first half): normal turns complete on this session.
  const plant = await s.runTurn(
    `Remember this exact token: ${token}. It must be preserved verbatim through any later summarisation. Reply with exactly the single word: ok`,
  );
  accountTurn('p2', plant);
  console.log(`\n${turnLine('CTRL-P2-TURN(a) plant turn', plant)} observed=${JSON.stringify(plant.observed)} text=${JSON.stringify(plant.text.trim().slice(0, 120))}`);

  for (let i = 1; i <= P2_WARMUP_TURNS; i++) {
    const w = await s.runTurn(
      `Warm-up ${i} of ${P2_WARMUP_TURNS}: name one fact about the port of Kalmar in at most 12 words.`,
    );
    accountTurn('p2', w);
    console.log(`  ${turnLine(`warm-up ${i}`, w)} text=${JSON.stringify(w.text.trim().slice(0, 90))}`);
  }
  const before = await s.readUsage();
  console.log(`  usage before /compact: ${usageLine(before)}`);

  const boundariesBefore = s.compactBoundaries.length;
  const compact = await s.runTurn('/compact');
  accountTurn('p2', compact);
  console.log(`\n${turnLine('/compact turn', compact)}`);
  console.log(`  message types observed during the /compact turn: ${JSON.stringify(compact.observed)}`);
  console.log(`  assistant text: ${JSON.stringify(compact.text.trim().slice(0, 600))}`);
  console.log(`  usage after /compact: ${usageLine(compact.usage)}`);
  const boundaries = s.compactBoundaries.slice(boundariesBefore);
  console.log(`  compact_boundary messages received: ${boundaries.length}`);
  for (const b of boundaries) {
    console.log(
      `    trigger=${b.compact_metadata.trigger} pre_tokens=${b.compact_metadata.pre_tokens} post_tokens=${b.compact_metadata.post_tokens ?? '(absent)'} duration_ms=${b.compact_metadata.duration_ms ?? '(absent)'} preserved_messages=${b.compact_metadata.preserved_messages ? b.compact_metadata.preserved_messages.uuids.length : '(none)'}`,
    );
  }

  // CTRL-P2-TURN (second half) doubles as the recall test.
  const recall = await s.runTurn(
    'Two questions, answered in two short lines. Line 1: the exact token I asked you to remember at the start of this conversation, verbatim, or the word UNKNOWN. Line 2: in at most 15 words, what this conversation has been about.',
  );
  accountTurn('p2', recall);
  const recalled = recall.text.includes(token);
  console.log(`\n${turnLine('CTRL-P2-TURN(b) recall turn', recall)}`);
  console.log(`  reply: ${JSON.stringify(recall.text.trim().slice(0, 300))}`);
  console.log(`  nonce ${token} recalled verbatim: ${recalled}`);
  console.log(`  usage after recall: ${usageLine(recall.usage)}`);
  console.log(`\nusage delta across /compact: before=${before.totalTokens} after=${compact.usage?.totalTokens ?? '?'}`);

  s.close();
  await s.waitForStreamEnd();

  const harnessAlive = !plant.timedOut && plant.result !== undefined && !recall.timedOut && recall.result !== undefined;
  // "Routed" means the CLI itself answered the command (as a command), which
  // is a different fact from "compaction ran" -- a short conversation gets a
  // refusal, not a boundary, and reading that refusal as "the command does
  // not exist" would be exactly wrong.
  const routed = /compact/i.test(compact.text);
  let verdict: string;
  let stop = false;
  if (boundaries.length > 0) {
    const b = boundaries[0].compact_metadata;
    verdict = `WORKS -- \`/compact\` sent as a plain streaming-input user message produced ${boundaries.length} compact_boundary message(s) through the query iterator (trigger=${b.trigger}, pre_tokens=${b.pre_tokens} -> post_tokens=${b.post_tokens ?? '?'}); getContextUsage().totalTokens ${before.totalTokens} -> ${compact.usage?.totalTokens ?? '?'}; nonce recall after compression: ${recalled ? 'SURVIVED verbatim' : 'LOST'}`;
  } else if (!harnessAlive) {
    verdict = 'STOP -- INDETERMINATE: the positive-control turns did not complete, so "no boundary" cannot be attributed to the SDK';
    stop = true;
  } else if (routed) {
    verdict = `ROUTED BUT DECLINED -- the CLI answered the command itself (${JSON.stringify(compact.text.trim().slice(0, 160))}) and emitted no compact_boundary. The command reaches the CLI over streaming input; this run did not build a conversation it agreed to compact. Types that arrived: ${JSON.stringify(compact.observed)}`;
  } else {
    verdict = `DOES NOT WORK -- no compact_boundary and no command-shaped reply. Types that DID arrive during the /compact turn: ${JSON.stringify(compact.observed)}. \`/compact\` ${compactCommand ? 'IS' : 'is NOT'} listed by supportedCommands()`;
  }

  verdicts.push({
    item: 'P2 (`/compact` over streaming input)',
    verdict,
    stop,
    control: 'CTRL-P2-TURN (a plant turn plus warm-up turns before, and a recall turn after, all completing on the same session in the same run)',
  });
}

// ---------------------------------------------------------------------------
// P3(ii) / P3(iii): what auto-ON (and auto-OFF) actually do under pressure
// ---------------------------------------------------------------------------

interface DriveOutcome {
  boundaries: number;
  rounds: number;
  firstBoundaryRound: number | null;
  usageBefore?: number;
  usageAfter?: number;
  threshold?: number;
  peakUsage?: number;
  recalled: boolean | null;
  gist: string;
  stoppedBy: string | null;
  harnessAlive: boolean;
  /**
   * The drop `sdk-engine.ts`'s PS1 tripwire actually sees across the
   * boundary. The tripwire compares consecutive `getContextUsage()` polls
   * against MATERIAL_DROP_RATIO (0.2), i.e. it fires when totalTokens falls
   * below 80% of the previous poll -- so this is the number that decides
   * whether it fires at a REAL auto-compaction, as opposed to the small
   * manual one P2 measured.
   */
  tripwireDropRatio: number | null;
  tripwireWouldFire: boolean | null;
}

/** Pressure rounds are capped so a mis-calibration cannot spin indefinitely. */
const MAX_PRESSURE_ROUNDS = 12;
/** Aim this far past the threshold, so a rounding error does not undershoot. */
const OVERSHOOT_TOKENS = 6_000;

async function drive(label: string, autoCompactEnabled: boolean, lever: Lever): Promise<DriveOutcome> {
  const settings: Settings = { autoCompactEnabled };
  const activeLever = autoCompactEnabled ? lever.kind : lever.offArmLever;
  if (activeLever === 'construct-window') settings.autoCompactWindow = lever.window;

  const s = new ProbeSession({ label, options: buildOptions(settings) });
  await s.waitForReady();

  if (activeLever === 'slash-autocompact') {
    const set = await s.runTurn(`/autocompact ${lever.window / 1000}k`);
    accountTurn(label, set);
    console.log(`${label}: /autocompact -> ${JSON.stringify(set.text.trim().slice(0, 120))}`);
  }

  let usage = await s.readUsage();
  console.log(`${label}: start ${usageLine(usage)}`);
  // With compaction OFF the threshold is not reported at all, so the OFF side
  // borrows the ON side's window arithmetic to build the SAME pressure.
  const threshold = usage.autoCompactThreshold ?? Math.max(1, lever.window - 33_000);
  console.log(`${label}: driving toward threshold ${threshold}${usage.autoCompactThreshold === undefined ? ' (derived -- not reported while compaction is off)' : ''}`);

  const token = nonce(`NONCE-${label.toUpperCase()}`);
  const plant = await s.runTurn(
    `Remember this exact token: ${token}. Also remember that this conversation is about a fictional shipping ledger for the port of Kalmar. Both facts must be preserved verbatim through any later summarisation. Reply with exactly the single word: ok`,
  );
  accountTurn(label, plant);
  const harnessAlive = !plant.timedOut && plant.result !== undefined;
  console.log(`${turnLine(`${label}: plant turn`, plant)} ${usageLine(plant.usage)}`);
  usage = plant.usage ?? usage;

  let rounds = 0;
  let firstBoundaryRound: number | null = null;
  let usageBefore: number | undefined = usage.totalTokens;
  let usageAfter: number | undefined;
  let peakUsage = usage.totalTokens;
  let stoppedBy: string | null = null;
  // Calibrated from the first round's measured delta; the initial guess only
  // has to be in the right order of magnitude.
  let charsPerToken = 3.5;

  while (s.compactBoundaries.length === 0) {
    const exceeded = budgetExceeded();
    if (exceeded) {
      stoppedBy = exceeded;
      break;
    }
    if (rounds >= MAX_PRESSURE_ROUNDS) {
      stoppedBy = `round cap (${MAX_PRESSURE_ROUNDS}) reached`;
      break;
    }
    rounds++;
    const gap = threshold + OVERSHOOT_TOKENS - (usage.totalTokens ?? 0);
    const chars = Math.max(2_000, Math.round(gap * charsPerToken));
    const before = s.compactBoundaries.length;
    const prevTotal = usage.totalTokens;
    const turn = await s.runTurn(
      `Round ${rounds} of the Kalmar ledger. Do not summarise it, do not comment on it, just acknowledge.\n\n${filler(chars, `r${rounds}:`)}\n\nReply with exactly the single word: ack`,
    );
    accountTurn(label, turn);
    if (turn.usage) {
      const delta = turn.usage.totalTokens - prevTotal;
      if (delta > 500) charsPerToken = chars / delta;
      usage = turn.usage;
      peakUsage = Math.max(peakUsage, turn.usage.totalTokens);
    }
    console.log(
      `${label}: round ${rounds} pushed ~${chars} chars -> ${turnLine('turn', turn)} boundaries=${s.compactBoundaries.length} ${usageLine(turn.usage)} charsPerToken~${charsPerToken.toFixed(2)} cumPromptTokens=${totalPromptTokens()} (fresh ${totalFreshPromptTokens()}) cost=$${totalCostUsd().toFixed(4)}`,
    );
    if (turn.timedOut || turn.streamError) {
      stoppedBy = `turn did not settle: ${turn.streamError ?? 'timeout'}`;
      break;
    }
    if (s.compactBoundaries.length > before) {
      firstBoundaryRound = rounds;
      usageBefore = prevTotal;
      usageAfter = turn.usage?.totalTokens;
      break;
    }
    usageBefore = turn.usage?.totalTokens;
  }

  for (const b of s.compactBoundaries) {
    console.log(
      `${label}: compact_boundary trigger=${b.compact_metadata.trigger} pre_tokens=${b.compact_metadata.pre_tokens} post_tokens=${b.compact_metadata.post_tokens ?? '(absent)'} duration_ms=${b.compact_metadata.duration_ms ?? '(absent)'} preserved_messages=${b.compact_metadata.preserved_messages ? b.compact_metadata.preserved_messages.uuids.length : '(none)'}`,
    );
  }

  let recalled: boolean | null = null;
  let gist = '';
  if (s.compactBoundaries.length > 0) {
    const recall = await s.runTurn(
      'Two questions, answered in two short lines. Line 1: the exact token I asked you to remember at the start of this conversation, verbatim, or the word UNKNOWN. Line 2: in at most 15 words, what this conversation has been about.',
    );
    accountTurn(label, recall);
    recalled = recall.text.includes(token);
    gist = recall.text.trim().slice(0, 400);
    console.log(`${turnLine(`${label}: post-compaction recall`, recall)} nonce=${recalled} reply=${JSON.stringify(gist)}`);
  }

  s.close();
  await s.waitForStreamEnd();

  // MATERIAL_DROP_RATIO in sdk-engine.ts is 0.2: the tripwire logs a
  // possible PS1 violation when totalTokens < previous * (1 - 0.2).
  const tripwireDropRatio =
    usageBefore !== undefined && usageAfter !== undefined && usageBefore > 0
      ? (usageBefore - usageAfter) / usageBefore
      : null;
  if (tripwireDropRatio !== null) {
    console.log(
      `${label}: PS1-tripwire measurement -- getContextUsage().totalTokens ${usageBefore} -> ${usageAfter} = ${(tripwireDropRatio * 100).toFixed(1)}% drop; sdk-engine.ts's MATERIAL_DROP_RATIO (0.2) would ${tripwireDropRatio > 0.2 ? 'FIRE' : 'NOT fire'}`,
    );
  }

  return {
    boundaries: s.compactBoundaries.length,
    rounds,
    firstBoundaryRound,
    usageBefore,
    usageAfter,
    threshold,
    peakUsage,
    recalled,
    gist,
    stoppedBy,
    harnessAlive,
    tripwireDropRatio,
    tripwireWouldFire: tripwireDropRatio === null ? null : tripwireDropRatio > 0.2,
  };
}

let p3OnOutcome: DriveOutcome | null = null;

async function itemP3On(lever: Lever): Promise<void> {
  h('P3(ii) -- what auto-compaction ON actually does under pressure');
  console.log(`pressure lever: ${lever.kind ?? 'NONE AVAILABLE -- driving against the model\'s own full window'} (window=${lever.window})`);
  console.log(`budget: $${budgetUsd} estimated cost / ${budgetMinutes} minutes\n`);

  const out = await drive('p3-on', true, lever);
  p3OnOutcome = out;

  let verdict: string;
  let stop = false;
  if (out.boundaries > 0) {
    verdict = `PS1-true CONFIRMED -- with \`autoCompactEnabled: true\`, compaction fired unprompted at pressure round ${out.firstBoundaryRound}: a \`system/compact_boundary\` reached the query iterator, and getContextUsage().totalTokens went ${out.usageBefore ?? '?'} -> ${out.usageAfter ?? '?'} against a threshold of ${out.threshold}. Post-compaction recall: nonce ${out.recalled ? 'SURVIVED verbatim' : 'was LOST'}; gist ${JSON.stringify(out.gist)}. PS1 tripwire at a REAL auto-compaction: ${out.tripwireDropRatio === null ? 'not measurable' : `${(out.tripwireDropRatio * 100).toFixed(1)}% drop, MATERIAL_DROP_RATIO(0.2) would ${out.tripwireWouldFire ? 'FIRE' : 'NOT fire'}`}`;
  } else if (!out.harnessAlive) {
    verdict = 'STOP -- INDETERMINATE: the plant turn never completed, so no conclusion about auto-ON is available';
    stop = true;
  } else {
    verdict = `STOP -- auto-ON did not reach a compaction inside the budget (${out.stoppedBy ?? 'unknown stop'}; ${out.rounds} pressure rounds, peak usage ${out.peakUsage} against threshold ${out.threshold}, $${totalCostUsd().toFixed(4)} spent, ${totalPromptTokens()} cumulative prompt tokens). #1400's budget-ceiling STOP applies: consult before concluding anything about PS1`;
    stop = true;
  }
  verdicts.push({
    item: 'P3(ii) (auto-ON fires)',
    verdict,
    stop,
    control: 'the plant turn and every pressure round completing in the same session (a dead harness could not have produced them)',
  });
}

async function itemP3Neg(lever: Lever): Promise<void> {
  h('P3(iii) -- the same pressure with auto-compaction OFF');

  // Refuse to spend anything on a confounded arm. If the OFF session cannot
  // be given the ON session's window, the two arms differ in TWO variables
  // (the flag and the effective window) and "no compaction occurred" is
  // fully explained by the second one. Reporting that as "PS1-false
  // confirmed under pressure" would be exactly the unfalsifiable claim
  // #1400 exists to retire -- so it is reported as UNVERIFIED instead, with
  // the structural reason, and no drive is run.
  if (!lever.offArmLever) {
    console.log(
      'ABORTING the OFF drive before it costs anything: the OFF arm cannot be given the ON arm\'s window\n' +
        '(see the P3(iii) prerequisite verdict). Any result would be confounded.',
    );
    verdicts.push({
      item: 'P3(iii) (auto-OFF holds under pressure)',
      verdict:
        "NOT VERIFIED UNDER PRESSURE -- structurally unreachable, not a budget shortfall. `autoCompactEnabled: false` discards `autoCompactWindow` along with compaction itself, so the OFF arm always runs against the model's FULL window. At that window the threshold is ~934000, and any pressure a probe can afford leaves the OFF arm far below the point where an enabled session would compact -- so its 'no boundary' is fully explained by the window and says nothing about the flag. Verifying it honestly would require driving to ~934000 tokens, beyond any realistic budget. What IS established about `false`: it arrives (P1a) and it reconfigures the SDK's compaction machinery (the `autoCompactThreshold` field appears and `maxTokens` shrinks when on, and both revert when off) -- stronger than a bare read-back, still short of behavior under pressure",
      stop: false,
      control:
        'NONE AVAILABLE -- the AC designed item (ii) to be this item\'s control, but that design cannot hold: the flag and the effective window move together, so the two arms can never differ in one variable. Recorded as a defect in the AC\'s control design, found by running it',
    });
    return;
  }

  console.log(
    `matching the ON side: ${p3OnOutcome?.firstBoundaryRound !== undefined && p3OnOutcome?.firstBoundaryRound !== null ? `ON fired at round ${p3OnOutcome.firstBoundaryRound} with peak usage ${p3OnOutcome.peakUsage}` : 'the ON side has no reference round in this run'}`,
  );
  console.log(`OFF-arm window lever: ${lever.offArmLever} (verified applicable in P3(i)'s prerequisite check)\n`);

  const out = await drive('p3-neg', false, lever);

  let verdict: string;
  if (!p3OnOutcome || p3OnOutcome.boundaries === 0) {
    verdict = `DOWNGRADED -- with \`false\`, ${out.rounds} pressure rounds (peak usage ${out.peakUsage}) produced ${out.boundaries} boundaries, but the ON control never fired in this run either, so it cannot distinguish "false was honored" from "the pressure was insufficient". Read-back confirmed only (P1a); NOT verified under pressure`;
  } else if (out.boundaries === 0) {
    verdict = `PS1-false CONFIRMED UNDER PRESSURE -- ${out.rounds} rounds carried usage to ${out.peakUsage} (past the ${out.threshold} threshold the ON side compacted at, in round ${p3OnOutcome.firstBoundaryRound}) with zero compact_boundary messages`;
  } else {
    verdict = `PS1-false VIOLATED -- compaction fired (${out.boundaries} boundaries) despite \`autoCompactEnabled: false\`. This contradicts the design doc's PS1 and must be consulted on before any swap ships`;
  }
  verdicts.push({
    item: 'P3(iii) (auto-OFF holds under pressure)',
    verdict,
    stop: false,
    control: 'CTRL-P3-ON -- item (ii) in this same run and commit, same lever, same pressure schedule',
  });
}

// ---------------------------------------------------------------------------
// P4: hooks (opportunistic)
// ---------------------------------------------------------------------------

async function itemP4Hooks(lever: Lever): Promise<void> {
  h('P4 -- can PreCompact / PostCompact be wired, and does compact_summary arrive?');

  const fired: string[] = [];
  let summaryChars: number | null = null;
  const settings: Settings = { autoCompactEnabled: true };
  if (lever.kind === 'construct-window') settings.autoCompactWindow = lever.window;

  let s: ProbeSession;
  try {
    s = new ProbeSession({
      label: 'p4',
      options: {
        ...buildOptions(settings),
        hooks: {
          PreCompact: [
            {
              hooks: [
                async (input) => {
                  fired.push(`PreCompact ${JSON.stringify(input).slice(0, 300)}`);
                  return { continue: true };
                },
              ],
            },
          ],
          PostCompact: [
            {
              hooks: [
                async (input) => {
                  const summary = (input as { compact_summary?: string }).compact_summary;
                  summaryChars = summary === undefined ? null : summary.length;
                  fired.push(`PostCompact compact_summary=${summary === undefined ? 'ABSENT' : `${summary.length} chars`}`);
                  return { continue: true };
                },
              ],
            },
          ],
        },
      },
    });
  } catch (err) {
    verdicts.push({
      item: 'P4 (compaction hooks)',
      verdict: `NON-RESULT -- the hooks could not be wired at all: ${err instanceof Error ? err.message : String(err)}`,
      stop: false,
      control: 'n/a (opportunistic item; a wiring failure is a recorded non-result, not a STOP)',
    });
    return;
  }

  await s.waitForReady();
  const plant = await s.runTurn('Reply with exactly the single word: ok');
  accountTurn('p4', plant);
  console.log(`${turnLine('plant turn', plant)} (proves the hook-wired session is alive)`);

  for (let i = 1; i <= P2_WARMUP_TURNS; i++) {
    const w = await s.runTurn(`Warm-up ${i}: name one fact about the port of Kalmar in at most 12 words.`);
    accountTurn('p4', w);
    console.log(`  ${turnLine(`warm-up ${i}`, w)}`);
  }
  const compact = await s.runTurn('/compact');
  accountTurn('p4', compact);
  console.log(`${turnLine('/compact turn', compact)} boundaries=${s.compactBoundaries.length} text=${JSON.stringify(compact.text.trim().slice(0, 200))}`);
  console.log(`hook callbacks fired: ${fired.length}`);
  for (const f of fired) console.log(`  ${f}`);

  s.close();
  await s.waitForStreamEnd();

  const alive = !plant.timedOut && plant.result !== undefined;
  verdicts.push({
    item: 'P4 (compaction hooks)',
    verdict:
      fired.length > 0
        ? `WIRED -- ${fired.length} hook callback(s) fired; compact_summary ${summaryChars === null ? 'was NOT delivered' : `delivered (${summaryChars} chars)`}`
        : alive
          ? `NON-RESULT -- hooks were accepted at construction but neither PreCompact nor PostCompact fired for this compaction attempt (${s.compactBoundaries.length} boundaries observed). Opportunistic item: recorded, not a STOP`
          : 'NON-RESULT -- the hook-wired session did not complete a turn, so nothing can be concluded',
    stop: false,
    control: 'the plant turn completing on the same hook-wired session (proves construction with hooks did not break the session)',
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`probe-sdk-compaction  started ${stamp()}`);
  console.log(`items: ${[...selected].join(' ')}`);
  console.log(`isolated CLAUDE_CONFIG_DIR: ${CONFIG_DIR}`);
  console.log(`model: ${MODEL}   budget: $${budgetUsd} estimated cost / ${budgetMinutes} min (cumulative prompt tokens are recorded, not gated -- see budgetUsd's comment)`);

  if (selected.has('--p1a')) await itemP1a();

  let lever: Lever = { kind: null, window: PROBE_WINDOW, offArmLever: null };
  if (selected.has('--p3i') || selected.has('--p3-on') || selected.has('--p3-neg') || selected.has('--p4-hooks')) {
    lever = await itemP3i();
  }
  if (selected.has('--p2')) await itemP2();
  if (selected.has('--p3-on')) await itemP3On(lever);
  if (selected.has('--p3-neg')) await itemP3Neg(lever);
  if (selected.has('--p4-hooks')) await itemP4Hooks(lever);

  const isolation = verifyIsolation(CONFIG_DIR);
  h('Isolation check');
  console.log(`child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`);
  console.log(`session transcripts written there: ${isolation.files.length}`);
  for (const f of isolation.files) console.log(`  ${f}`);
  if (!isolation.ok) {
    console.error(
      'ISOLATION NOT VERIFIED: the child wrote no state into the throwaway config dir, so the CLAUDE_CONFIG_DIR override may not have reached it. Every isolation claim about this run would be unfounded.',
    );
    return 2;
  }

  h('Verdicts');
  for (const v of verdicts) {
    console.log(`\n- ${v.item}\n    verdict: ${v.verdict}\n    control: ${v.control}`);
  }
  console.log(
    `\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${totalPromptTokens()} (${totalFreshPromptTokens()} excluding cache reads)  approx cost=$${totalCostUsd().toFixed(4)}`,
  );

  return verdicts.some((v) => v.stop) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('probe could not run:', err);
    process.exit(2);
  });
