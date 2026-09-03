#!/usr/bin/env bun
/**
 * Task 0 gate probe for Issue #1343's scoped section ("project-instruction
 * parity on the SDK arm"). Measurement only -- this script changes no
 * production behavior and is not wired into CI, same class of tool as
 * `probe-sdk-resume.ts` / `probe-sdk-compaction.ts`.
 *
 * The whole Phase A design (a NEW loader-driven `.claude/rules` layer,
 * composed the same way for both engines, with `settingSources: []` left
 * untouched on the SDK arm) rests on one premise: that `settingSources: []`
 * suppresses the SDK's native project-instruction discovery ENTIRELY --
 * CLAUDE.md, and also any native `.claude/rules/*.md` auto-discovery the
 * `claude` CLI itself performs -- rather than suppressing only some of it.
 * This probe checks that premise against a real SDK session before any
 * loader code is written.
 *
 * Two arms, one scratch git repo with three unguessable canary tokens:
 *
 *   - CLAUDE.md                     canary A (project instructions)
 *   - .claude/rules/unscoped.md     canary B (no frontmatter -- unscoped)
 *   - .claude/rules/scoped.md       canary C (`paths: ["src/**"]` -- scoped)
 *   - src/x.ts                      a touch target for the scoped rule's glob
 *
 *   --off      `settingSources: []` (what ships today). Ask whether the
 *              model knows canaries A/B/C, have it Read src/x.ts, ask again.
 *              EXPECTED: none of A/B/C known, before or after the Read. This
 *              is the premise the whole Phase A slice rests on -- if B or C
 *              appear at either asking, STOP: the SDK loads `.claude/rules`
 *              independently of `settingSources`, and the design changes.
 *   --project  `settingSources: ['project']` (positive control). Proves the
 *              canaries are detectable at all and documents the CLI's own
 *              activation semantics. EXPECTED: A and B known at the first
 *              asking (project-level, loaded at session start); C unknown
 *              at the first asking and known only after the Read (native
 *              lazy scoped-rule activation on a matching path touch).
 *
 * Default (no item flag) = both arms, in order.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user (this repo's own claude-sdk auth, not a provider key). Billable --
 * six small turns total across both arms.
 *
 * Usage: bun scripts/smoke/probe-sdk-instruction-loading.ts [--off] [--project]
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SettingSource } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
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

const ITEM_FLAGS = ['--off', '--project'] as const;
const USAGE_TEXT = 'Usage: bun scripts/smoke/probe-sdk-instruction-loading.ts [--off] [--project]\n  Default (no item flag) = both.';

function parseArgs(argv: string[]): Set<string> {
  const selected = new Set<string>();
  for (const a of argv) {
    if ((ITEM_FLAGS as readonly string[]).includes(a)) {
      selected.add(a);
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(2);
  }
  if (selected.size === 0) {
    selected.add('--off');
    selected.add('--project');
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
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

/** Mirrors `sdk-engine.ts`'s `buildOptions` pins, `settingSources` and `cwd` supplied per-arm. */
function buildOptions(cwd: string, settingSources: SettingSource[]): Options {
  return {
    executable: 'bun',
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources,
    settings: { autoCompactEnabled: false },
  };
}

interface Canaries {
  a: string;
  b: string;
  c: string;
}

/**
 * Builds the scratch git repo once, shared by both arms (read-only content,
 * no arm-specific state). Layout matches the AC's Task 0 spec verbatim.
 */
function buildScratchRepo(): { dir: string; canaries: Canaries } {
  const dir = mkdtempSync(join(tmpdir(), 'probe-sdk-instructions-'));
  try {
    const canaries: Canaries = {
      a: nonce('CANARY-ALPHA'),
      b: nonce('CANARY-BRAVO'),
      c: nonce('CANARY-CHARLIE'),
    };

    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });

    writeFileSync(join(dir, 'CLAUDE.md'), `# Project Instructions\n\nProject canary word: ${canaries.a}\n`);

    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'rules', 'unscoped.md'),
      `# Unscoped Rule\n\nUnscoped-rule canary word: ${canaries.b}\n`,
    );
    writeFileSync(
      join(dir, '.claude', 'rules', 'scoped.md'),
      `---\npaths: ["src/**"]\n---\n\n# Scoped Rule\n\nScoped-rule canary word: ${canaries.c}\n`,
    );

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1;\n');

    return { dir, canaries };
  } catch (err) {
    // Setup failed after mkdtempSync already created `dir` -- clean it up
    // before rethrowing, rather than leaking it (CodeRabbit finding).
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function askPrompt(canaries: Canaries): string {
  return (
    'Do you currently know any of these three canary words: one starting with ' +
    `"${canaries.a.split('-').slice(0, 2).join('-')}", one starting with ` +
    `"${canaries.b.split('-').slice(0, 2).join('-')}", one starting with ` +
    `"${canaries.c.split('-').slice(0, 2).join('-')}"? For each of the three, either quote it exactly ` +
    'if you can see it verbatim in your own context, or say "unknown" if you cannot. Do not guess.'
  );
}

const READ_PROMPT = 'Please use your Read tool to read the file src/x.ts (relative to your working directory) and tell me its exact contents.';

function detect(text: string, canaries: Canaries): { a: boolean; b: boolean; c: boolean } {
  return {
    a: text.includes(canaries.a),
    b: text.includes(canaries.b),
    c: text.includes(canaries.c),
  };
}

interface ArmResult {
  label: string;
  settingSources: SettingSource[];
  ask1: TurnOutcome;
  ask1Found: { a: boolean; b: boolean; c: boolean } | null;
  read: TurnOutcome;
  ask2: TurnOutcome;
  ask2Found: { a: boolean; b: boolean; c: boolean } | null;
}

async function runArm(
  label: string,
  settingSources: SettingSource[],
  repoDir: string,
  canaries: Canaries,
): Promise<ArmResult> {
  h(`Arm: ${label} (settingSources=${JSON.stringify(settingSources)})`);
  const options = buildOptions(repoDir, settingSources);
  const s = new ProbeSession({ label, options });
  const ready = await s.waitForReady();
  console.log(`${label} ready: ${ready}`);

  const prompt = askPrompt(canaries);
  const ask1 = await s.runTurn(prompt);
  account(`${label}-ask1`, ask1);
  console.log(turnLine(`${label} ask#1`, ask1));
  const ask1Found = turnSettled(ask1) ? detect(ask1.text, canaries) : null;
  console.log(`${label} ask#1 found: ${JSON.stringify(ask1Found)}`);
  const ask1Unsettled = unsettledReason(ask1, `${label} ask#1`);
  if (ask1Unsettled) console.log(ask1Unsettled);

  const read = await s.runTurn(READ_PROMPT);
  account(`${label}-read`, read);
  console.log(turnLine(`${label} read`, read));
  const readUnsettled = unsettledReason(read, `${label} read`);
  if (readUnsettled) console.log(readUnsettled);

  const ask2 = await s.runTurn(prompt);
  account(`${label}-ask2`, ask2);
  console.log(turnLine(`${label} ask#2`, ask2));
  const ask2Found = turnSettled(ask2) ? detect(ask2.text, canaries) : null;
  console.log(`${label} ask#2 found: ${JSON.stringify(ask2Found)}`);
  const ask2Unsettled = unsettledReason(ask2, `${label} ask#2`);
  if (ask2Unsettled) console.log(ask2Unsettled);

  s.close();
  await s.waitForStreamEnd();

  return { label, settingSources, ask1, ask1Found, read, ask2, ask2Found };
}

async function main(): Promise<number> {
  const selected = parseArgs(process.argv.slice(2));
  const configDir = isolateClaudeConfigDir('instr');
  let repoDir: string | undefined;

  try {
    const built = buildScratchRepo();
    repoDir = built.dir;
    const { canaries } = built;

    console.log(`probe-sdk-instruction-loading  started ${stamp()}`);
    console.log(`items: ${[...selected].join(' ')}`);
    console.log(`isolated CLAUDE_CONFIG_DIR: ${configDir}`);
    console.log(`scratch git repo: ${repoDir}`);
    console.log(`model: ${MODEL}`);

    const sdkPackageJson = await Bun.file(
      join(import.meta.dir, '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    ).json();
    console.log(`@anthropic-ai/claude-agent-sdk version: ${sdkPackageJson.version}`);

    const results: ArmResult[] = [];
    if (selected.has('--off')) {
      results.push(await runArm('off', [], repoDir, canaries));
    }
    if (selected.has('--project')) {
      results.push(await runArm('project', ['project'], repoDir, canaries));
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
    for (const r of results) {
      if (r.label !== 'off') continue;
      if (r.ask1Found === null || r.ask2Found === null) {
        console.log(`off arm: INDETERMINATE -- a turn did not settle, no measurement available.`);
        stop = true;
        continue;
      }
      const leaked = r.ask1Found.b || r.ask1Found.c || r.ask2Found.b || r.ask2Found.c;
      if (leaked) {
        console.log(
          `off arm: STOP -- settingSources: [] LEAKED a rules canary (ask#1=${JSON.stringify(r.ask1Found)} ask#2=${JSON.stringify(r.ask2Found)}). The SDK loads .claude/rules independently of settingSources; the Phase A design premise is FALSE.`,
        );
        stop = true;
      } else {
        console.log(
          `off arm: PASS -- no rules canary (B/C) known before or after Read (ask#1=${JSON.stringify(r.ask1Found)} ask#2=${JSON.stringify(r.ask2Found)}). CLAUDE.md canary (A) also ${r.ask1Found.a || r.ask2Found.a ? 'LEAKED (unexpected)' : 'absent (expected)'}.`,
        );
      }
    }
    for (const r of results) {
      if (r.label !== 'project') continue;
      if (r.ask1Found === null || r.ask2Found === null) {
        console.log(`project arm: INDETERMINATE -- a turn did not settle, no measurement available.`);
        continue;
      }
      const startOk = r.ask1Found.a && r.ask1Found.b && !r.ask1Found.c;
      const afterOk = r.ask2Found.c;
      console.log(
        `project arm: A@start=${r.ask1Found.a} B@start=${r.ask1Found.b} C@start=${r.ask1Found.c} C@afterRead=${r.ask2Found.c}. Positive-control shape ${startOk && afterOk ? 'CONFIRMED' : 'NOT confirmed as expected'} (expected A&B known at start, C unknown at start and known after the Read).`,
      );
    }

    const t = totals();
    console.log(
      `\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`,
    );

    return stop ? 1 : 0;
  } finally {
    // Neither the throwaway CLAUDE_CONFIG_DIR nor the scratch repo is
    // cleaned up by any exit path otherwise (CodeRabbit finding) -- every
    // reachable return/throw from the try block above goes through here.
    rmSync(configDir, { recursive: true, force: true });
    if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
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
