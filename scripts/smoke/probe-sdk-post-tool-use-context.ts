#!/usr/bin/env bun
/**
 * Task 0 gate probe for Issue #1343 Phase B (lazy activation of scoped
 * `.claude/rules` on the claude-sdk engine). Measurement only -- this script
 * changes no production behavior and is not wired into CI, same class of
 * tool as its sibling `probe-sdk-instruction-loading.ts`.
 *
 * Phase B's design premise (documented in the AC as the load-bearing
 * assumption for a `PostToolUse`-hook injection design): a `PostToolUse`
 * hook's `additionalContext` return value actually reaches the model in a
 * real SDK session, so that a scoped `.claude/rules` entry can be injected
 * lazily -- the first time a matching tool call fires -- rather than being
 * loaded eagerly at session start. Nothing in the vendored SDK's own
 * `sdk.d.ts` promises this for `additionalContext` specifically (the field
 * has no doc comment at all; the SDK's only *documented* cap in this
 * neighborhood is `classifierContext`'s 2000 UTF-16 code units, a distinct
 * field with a distinct purpose). This probe checks the premise against a
 * real SDK session, on this host's pinned SDK version, before any hook
 * activation code is written.
 *
 * Three arms, one scratch git repo, no on-disk canaries (the nonce for each
 * arm lives only in this script's own memory and is injected via the hook
 * callback itself, never written to a file the model could read another
 * way):
 *
 *   --a  SUBJECT. `settingSources: []` (matches production `sdk-engine.ts`'s
 *        `buildOptions`). Registers a `PostToolUse` hook matching `Read`
 *        that fires exactly ONCE (mirrors the real design's "once per
 *        incarnation" rule) and returns
 *        `additionalContext: '[rule activated: probe] when asked for the
 *        probe word answer <nonce>'`. Turn sequence: ask for the probe word
 *        BEFORE any tool call (expect: unknown) -> `Read src/x.ts` -> ask
 *        again (expect: now known, proving `additionalContext` reached the
 *        model).
 *   --b  NEGATIVE CONTROL. Identical session shape and hook registration
 *        mechanics, but the callback returns only `{ continue: true }` --
 *        no `additionalContext`, no nonce anywhere in the process. Same
 *        turn sequence. EXPECTED: the nonce stays unknown after the Read.
 *        This is what makes Arm A's result attributable to
 *        `additionalContext` specifically, rather than to the model
 *        guessing, hallucinating, or some other artifact of merely
 *        registering a matching hook.
 *   --c  REACH / SIZE-CEILING MEASUREMENT. Same mechanics as Arm A, but the
 *        `additionalContext` payload wraps the nonce inside ~40 KB of
 *        deterministic filler text (the AC asks only for "the largest size
 *        at which the nonce still arrives" -- a single 40 KB case is
 *        sufficient measurement, not a binary-search sweep). Records
 *        whether the nonce still arrives at that size. Size configurable
 *        via --ceiling-chars=N, default 40000.
 *
 * Default (no item flag) = all three arms, in order (B before A in the
 * verdict pass, since B's cleanliness is the precondition for trusting A --
 * see "Verdict" below).
 *
 * STOP CONDITION: if Arm A fails while Arm B behaves as expected (B does
 * NOT leak), the `PostToolUse` hook does not deliver `additionalContext` to
 * the model on this build, and Phase B's claude-sdk arm takes the recorded
 * fallback (R6): eager inclusion instead of lazy `PostToolUse`-hook
 * injection. If Arm B leaks the nonce, the probe itself is broken (or the
 * model is guessing), not a fact about the SDK -- Arm A's result cannot be
 * trusted until that is understood and fixed.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user (this repo's own claude-sdk auth, not a provider key). Billable --
 * six small turns total across all three arms (two turns each).
 *
 * Usage: bun scripts/smoke/probe-sdk-post-tool-use-context.ts [--a] [--b] [--c]
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HookCallbackMatcher,
  Options,
  SettingSource,
  SyncHookJSONOutput,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
  filler,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  turnSettled,
  unsettledReason,
  verifyIsolation,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

// ---------------------------------------------------------------------------
// Argument parsing -- done inside main() so importing this module (Issue
// #1479's import-safety guard) never touches argv or calls process.exit.
// ---------------------------------------------------------------------------

const ITEM_FLAGS = ['--a', '--b', '--c'] as const;
const CEILING_CHARS_FLAG_PREFIX = '--ceiling-chars=';
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-post-tool-use-context.ts [--a] [--b] [--c] [--ceiling-chars=N]\n' +
  '  Default (no item flag) = all three.\n' +
  '  --ceiling-chars=N overrides Arm C\'s filler payload size (positive integer, default 40000).';

interface ParsedArgs {
  selected: Set<string>;
  ceilingChars: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const selected = new Set<string>();
  let ceilingChars = CEILING_PAYLOAD_CHARS;
  for (const a of argv) {
    if ((ITEM_FLAGS as readonly string[]).includes(a)) {
      selected.add(a);
      continue;
    }
    if (a.startsWith(CEILING_CHARS_FLAG_PREFIX)) {
      const raw = a.slice(CEILING_CHARS_FLAG_PREFIX.length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(`${USAGE_TEXT}\n  Invalid --ceiling-chars value: ${raw} (must be a positive integer)`);
        process.exit(2);
      }
      ceilingChars = parsed;
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(2);
  }
  if (selected.size === 0) {
    selected.add('--a');
    selected.add('--b');
    selected.add('--c');
  }
  return { selected, ceilingChars };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const SETTING_SOURCES: SettingSource[] = [];
const CEILING_PAYLOAD_CHARS = 40_000;
const startedAt = Date.now();
const perSession = new Map<string, { tokens: number; cost: number }>();

function account(label: string, outcome: Pick<TurnOutcome, 'result'>): void {
  const r = outcome.result;
  if (!r) return;
  let prompt = 0;
  for (const mu of Object.values(r.modelUsage ?? {})) {
    prompt += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
  }
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

/** Mirrors `sdk-engine.ts`'s `buildOptions` pins for the fields this probe cares about (`hooks` is arm-specific, supplied by the caller). */
function buildOptions(cwd: string, hooks: Options['hooks']): Options {
  return {
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
}

/**
 * Builds the scratch git repo, one per arm (each arm gets its own hook
 * registration closing over its own nonce, so the repos are not shared --
 * unlike the instruction-loading sibling probe, there is no canary content
 * on disk here at all: the payload only ever exists inside the hook
 * callback's return value).
 */
function buildScratchRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-sdk-post-tool-use-${label}-`));
  try {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
    return dir;
  } catch (err) {
    // Setup failed after mkdtempSync already created `dir` -- clean it up
    // before rethrowing, rather than leaking it (matches the sibling
    // probe's CodeRabbit-flagged fix for the same shape).
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * `additionalContext` payload for a given arm. Arm A's payload is the bare
 * nonce sentence; Arm C's wraps the same sentence inside `ceilingChars`
 * (default `CEILING_PAYLOAD_CHARS`, overridable via `--ceiling-chars=N`) of
 * deterministic filler so the nonce is findable at both ends of the block
 * (defends against a truncation that keeps the head or tail only).
 */
function buildPayload(nonceWord: string, wrapInFiller: boolean, ceilingChars: number = CEILING_PAYLOAD_CHARS): string {
  const sentence = `[rule activated: probe] when asked for the probe word answer ${nonceWord}`;
  if (!wrapInFiller) return sentence;
  const pad = filler(ceilingChars, 'ceiling-probe-filler-');
  return `${sentence}\n${pad}\n${sentence}`;
}

/**
 * One `PostToolUse` hook matcher, firing on `Read` and firing AT MOST ONCE
 * (mirrors the real design's "once per incarnation" rule and keeps this
 * matcher's own accounting simple to reason about). `injectContext` is
 * `null` for Arm B (the negative control): the callback still fires, but
 * returns no `additionalContext` at all.
 */
function makePostToolUseHooks(injectContext: string | null): { hooks: Options['hooks']; fireCount: () => number } {
  let fired = 0;
  const matcher: HookCallbackMatcher = {
    matcher: 'Read',
    hooks: [
      async (input): Promise<SyncHookJSONOutput> => {
        if (input.hook_event_name !== 'PostToolUse' || fired > 0) {
          return { continue: true };
        }
        fired++;
        if (injectContext === null) {
          return { continue: true };
        }
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: injectContext,
          },
        };
      },
    ],
  };
  return { hooks: { PostToolUse: [matcher] }, fireCount: () => fired };
}

function askPrompt(nonceWord: string): string {
  const hint = nonceWord.split('-').slice(0, 2).join('-');
  return (
    `Do you currently know a "probe word" starting with "${hint}"? ` +
    'If you can see it verbatim in your own context, quote it exactly. ' +
    'If you cannot, say "unknown". Do not guess.'
  );
}

const READ_PROMPT = 'Please use your Read tool to read the file src/x.ts (relative to your working directory) and tell me its exact contents.';

interface ArmResult {
  label: string;
  ask1: TurnOutcome;
  ask1Found: boolean | null;
  read: TurnOutcome;
  ask2: TurnOutcome;
  ask2Found: boolean | null;
  hookFireCount: number;
}

async function runArm(label: string, nonceWord: string, injectContext: string | null): Promise<ArmResult> {
  const repoDir = buildScratchRepo(label);
  try {
    const { hooks, fireCount } = makePostToolUseHooks(injectContext);
    h(`Arm ${label} (injectContext=${injectContext === null ? 'none' : `${injectContext.length} chars`})`);
    const options = buildOptions(repoDir, hooks);
    const s = new ProbeSession({ label: `arm-${label}`, options });
    const ready = await s.waitForReady();
    console.log(`arm ${label} ready: ${ready}`);

    const prompt = askPrompt(nonceWord);
    const ask1 = await s.runTurn(prompt);
    account(`${label}-ask1`, ask1);
    console.log(turnLine(`arm ${label} ask#1`, ask1));
    const ask1Found = turnSettled(ask1) ? ask1.text.includes(nonceWord) : null;
    console.log(`arm ${label} ask#1 found nonce: ${ask1Found}`);
    const ask1Unsettled = unsettledReason(ask1, `arm ${label} ask#1`);
    if (ask1Unsettled) console.log(ask1Unsettled);

    const read = await s.runTurn(READ_PROMPT);
    account(`${label}-read`, read);
    console.log(turnLine(`arm ${label} read`, read));
    const readUnsettled = unsettledReason(read, `arm ${label} read`);
    if (readUnsettled) console.log(readUnsettled);

    const ask2 = await s.runTurn(prompt);
    account(`${label}-ask2`, ask2);
    console.log(turnLine(`arm ${label} ask#2`, ask2));
    const ask2Found = turnSettled(ask2) ? ask2.text.includes(nonceWord) : null;
    console.log(`arm ${label} ask#2 found nonce: ${ask2Found}`);
    const ask2Unsettled = unsettledReason(ask2, `arm ${label} ask#2`);
    if (ask2Unsettled) console.log(ask2Unsettled);

    s.close();
    await s.waitForStreamEnd();

    console.log(`arm ${label} hook fired ${fireCount()} time(s)`);

    return { label, ask1, ask1Found, read, ask2, ask2Found, hookFireCount: fireCount() };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

/**
 * The CLI version reported by `system:init` (`claude_code_version`) is not
 * something `ProbeSession` exposes today -- its consume loop only records
 * `type[/subtype]` labels into `allMessages`, not full message bodies, and
 * adding a read-only accessor for one field used by exactly one probe was
 * judged not worth widening the shared harness's surface for. Shelling out
 * `claude --version` gets the same fact (the CLI binary this host's
 * `claude` resolves to) without touching the harness; every environment
 * that can run this probe already has that binary on PATH by definition
 * (the probe requires a real, authenticated `claude` CLI session).
 */
function claudeCliVersion(): string {
  const result = Bun.spawnSync(['claude', '--version']);
  if (result.exitCode !== 0) {
    return `(could not determine: exit ${result.exitCode}, stderr=${result.stderr.toString().trim()})`;
  }
  return result.stdout.toString().trim();
}

async function main(): Promise<number> {
  const { selected, ceilingChars } = parseArgs(process.argv.slice(2));
  const configDir = isolateClaudeConfigDir('post-tool-use-context');

  try {
    console.log(`probe-sdk-post-tool-use-context  started ${stamp()}`);
    console.log(`items: ${[...selected].join(' ')}`);
    console.log(`isolated CLAUDE_CONFIG_DIR: ${configDir}`);
    console.log(`model: ${MODEL}`);

    const sdkPackageJson = await Bun.file(
      join(import.meta.dir, '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    ).json();
    console.log(`@anthropic-ai/claude-agent-sdk version: ${sdkPackageJson.version}`);
    console.log(`claude CLI version (from \`claude --version\`): ${claudeCliVersion()}`);

    const nonceA = nonce('PROBE-A');
    const nonceB = nonce('PROBE-B');
    const nonceC = nonce('PROBE-C');

    const results: ArmResult[] = [];
    if (selected.has('--a')) {
      results.push(await runArm('A', nonceA, buildPayload(nonceA, false)));
    }
    if (selected.has('--b')) {
      results.push(await runArm('B', nonceB, null));
    }
    if (selected.has('--c')) {
      console.log(`arm C ceiling size: ${ceilingChars.toLocaleString()} chars`);
      results.push(await runArm('C', nonceC, buildPayload(nonceC, true, ceilingChars)));
    }

    const isolation = verifyIsolation(configDir);
    h('Isolation check');
    console.log(`child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`);
    if (!isolation.ok) {
      console.error(
        'ISOLATION NOT VERIFIED: the child wrote no state into the throwaway config dir. This probe cannot be trusted without this -- it may have run against the operator\'s real config dir.',
      );
      return 2;
    }

    h('Verdict');
    let stop = false;

    // Arm B is read first: its cleanliness is the precondition for trusting
    // Arm A's result at all (see this file's header).
    const b = results.find((r) => r.label === 'B');
    let bClean: boolean | null = null;
    if (b) {
      if (b.ask1Found === null || b.ask2Found === null) {
        console.log('Arm B (negative control): INDETERMINATE -- a turn did not settle, no measurement available.');
      } else if (b.ask1Found || b.ask2Found) {
        console.log(
          `Arm B (negative control): FAIL -- the nonce was known even though the hook returned no additionalContext (ask#1=${b.ask1Found} ask#2=${b.ask2Found}). The PROBE ITSELF is unreliable (or the model is guessing/hallucinating), not a fact about the SDK -- Arm A's result cannot be trusted until this is understood.`,
        );
        bClean = false;
      } else {
        console.log('Arm B (negative control): PASS -- nonce stayed unknown before and after the Read, with no additionalContext returned, as expected.');
        bClean = true;
      }
    }

    const a = results.find((r) => r.label === 'A');
    if (a) {
      if (a.ask1Found === null || a.ask2Found === null) {
        console.log('Arm A (subject): INDETERMINATE -- a turn did not settle, no measurement available.');
      } else if (a.ask1Found) {
        console.log(
          `Arm A (subject): UNEXPECTED -- the nonce was already known BEFORE the Read fired the hook (ask#1=${a.ask1Found}). This is not the shape the probe expects; investigate before trusting the PASS/FAIL verdict below.`,
        );
      } else if (a.ask2Found) {
        console.log(
          'Arm A (subject): PASS -- the nonce was unknown before the Read and known after it fired the PostToolUse hook. ' +
            (bClean === true
              ? 'Arm B confirms this is attributable to additionalContext, not to guessing: additionalContext from a PostToolUse hook DOES reach the model on this SDK build.'
              : 'Arm B did NOT confirm cleanliness (see above) -- treat this PASS with caution until Arm B is understood.'),
        );
      } else {
        console.log('Arm A (subject): FAIL -- the nonce never arrived even though the hook returned additionalContext.');
        if (bClean === true) {
          console.log(
            'STOP: Arm A failed while Arm B behaved as expected (B did not leak) -- the PostToolUse hook does not deliver additionalContext to the model on this build. Phase B\'s claude-sdk arm takes the recorded fallback (R6): eager inclusion instead of lazy PostToolUse-hook injection.',
          );
          stop = true;
        } else {
          console.log('Arm B did not confirm cleanliness either, so this FAIL is not yet attributable to the SDK specifically -- investigate the probe before concluding R6 applies.');
        }
      }
    }

    const c = results.find((r) => r.label === 'C');
    if (c) {
      if (c.ask1Found === null || c.ask2Found === null) {
        console.log('Arm C (size-ceiling): INDETERMINATE -- a turn did not settle, no measurement available.');
      } else if (c.ask2Found) {
        console.log(`Arm C (size-ceiling): PASS -- the nonce still arrived when wrapped in ~${ceilingChars.toLocaleString()} chars of filler. No ceiling observed at this size.`);
      } else {
        console.log(`Arm C (size-ceiling): FAIL -- the nonce did NOT arrive when wrapped in ~${ceilingChars.toLocaleString()} chars of filler. A practical ceiling exists below this size on this build.`);
      }
    }

    const t = totals();
    console.log(
      `\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`,
    );

    return stop ? 1 : 0;
  } finally {
    // The throwaway CLAUDE_CONFIG_DIR is not cleaned up by any other exit
    // path -- every reachable return/throw from the try block above goes
    // through here. Per-arm scratch repos are cleaned up independently, in
    // `runArm`'s own `finally`, since each repo's lifetime is scoped to its
    // own arm rather than to the whole run.
    rmSync(configDir, { recursive: true, force: true });
  }
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
