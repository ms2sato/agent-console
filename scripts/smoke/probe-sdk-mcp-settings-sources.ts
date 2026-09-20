#!/usr/bin/env bun
/**
 * Task 0 measurement probe for epic #1636 Phase 5, owner directive
 * (2026-09-20): measure `settingSources: ['user']` first, then the
 * SDK-side gates around it (`Settings.enabledMcpjsonServers` /
 * `disabledMcpjsonServers` / `enableAllProjectMcpServers`,
 * `Options.managedSettings` vs `Options.settings` as carriers for
 * `allowedMcpServers` / `deniedMcpServers`, `Settings.claudeMdExcludes`,
 * `Settings.disableClaudeAiConnectors`, `Settings.disableAllHooks`). This is
 * a MEASUREMENT, not an implementation -- it changes no production
 * behavior and is not wired into CI, same class of tool as
 * `probe-sdk-declared-mcp-and-task.ts` (Issue #1726), whose seeding and
 * isolation pattern this script reuses via its `startAgentConsoleStandIn`
 * and `readUserScopeMcpServers` exports. The design section this feeds is
 * `docs/design/embedded-agent-sdk-engine.md` section 4.5 (a rewrite comes
 * AFTER these numbers exist).
 *
 * SDK FACTS THE ARMS ARE BUILT ON (vendored `sdk.d.ts` 0.3.238 -- every line
 * anchor below was diffed against the file this repo actually vendors
 * before this probe was written; none had moved):
 *
 *   - `Options.settingSources` L2014: 'user' = `~/.claude/settings.json`
 *     (and, empirically, the sibling `~/.claude.json` -- both relocate under
 *     `CLAUDE_CONFIG_DIR` together, confirmed against the real operator
 *     config before this probe was written), 'project' = `.claude/settings.json`
 *     (required for CLAUDE.md), 'local'; omitted = all; `[]` = isolation.
 *   - `Options.settings` L1979 (= `--settings`, highest user-controlled
 *     tier) carries the TUI's own approval keys: `enabledMcpjsonServers`
 *     L5496, `disabledMcpjsonServers` L5500, `enableAllProjectMcpServers`
 *     L5492.
 *   - `Options.managedSettings` L2003: parent-supplied policy tier,
 *     "intended for embedding applications"; restrictive-only filtered
 *     (L2790-2793: `allowManaged*Only` locks, `permissions.deny`/`ask`,
 *     sandbox). `allowedMcpServers` (a permissive array) is documented
 *     (L1984-1990) as silently dropped; `deniedMcpServers` (restrictive) is
 *     expected to survive. Whether `allowedMcpServers`/`deniedMcpServers`
 *     via `Options.settings` applies at all is UNDOCUMENTED -> measure.
 *   - `Settings.allowedMcpServers` L5518 / `deniedMcpServers` L5537: match
 *     by `serverName`, `serverCommand: [cmd, ...args]` EXACT array, or
 *     `serverUrl` wildcard; deny wins; empty allow-array = nothing allowed.
 *   - `Settings.claudeMdExcludes` L7606: glob/absolute paths of CLAUDE.md
 *     files (picomatch-matched) to exclude from loading -- a knob to enable
 *     `'project'` without native CLAUDE.md/rules double-loading. Tier
 *     unknown -> measure.
 *   - `Settings.disableClaudeAiConnectors` L5504, `Settings.disableAllHooks`
 *     L5767.
 *   - `strictMcpConfig` L2057-2063 ignores `.mcp.json`, user settings,
 *     plugins, on-disk agent frontmatter MCP -- so `['user']` + strict
 *     cannot coexist for MCP specifically (arm A2 measures this).
 *   - A stdio server's `command` is exec'd at connect, so "blocked" in a
 *     native-load design means the process never started; `mcp_servers[].status`
 *     alone cannot distinguish "never attempted" from other absent shapes.
 *     Every stdio server in this probe is therefore the `stdio-echo-mcp-server.ts`
 *     SPAWN-CANARY fixture (touches a unique file at start, then serves);
 *     "started / not started" is read from that file, cross-checked against
 *     `system:init.mcp_servers`.
 *
 * SEEDING (all inside the isolated `<configDir>` + a scratch git repo; the
 * `<configDir>`'s user-scope `mcpServers` seed is copied from the operator's
 * real `~/.claude.json` ONLY for the reserved-pair regression control, via
 * the sibling's `startAgentConsoleStandIn`; every probe-specific server
 * below is hand-authored, not copied, since the whole point is controlling
 * exactly which scope declares which server):
 *
 *   `<configDir>/.claude.json`  -- user-scope server U + `projects[<cwd>]
 *                                  .mcpServers` (local-scope) server L, both
 *                                  the stdio-echo fixture with distinct
 *                                  canaries. Verified against the real
 *                                  operator `~/.claude.json` before writing
 *                                  this probe: `projects[<absoluteCwd>]
 *                                  .mcpServers` IS the on-disk local-scope
 *                                  shape (the real file's own
 *                                  `/home/.../agent-console` project entry
 *                                  carries exactly this).
 *   `<configDir>/CLAUDE.md`     -- user-level canary word.
 *   `<configDir>/agents/probe-user-agent.md` -- user-scope custom agent.
 *   `<scratchRepo>/.mcp.json`  -- project-scope servers X, Y (stdio-echo,
 *                                  distinct canaries).
 *   `<scratchRepo>/CLAUDE.md`  -- project-level canary word.
 *   `<scratchRepo>/.claude/rules/unscoped.md` -- unscoped-rule canary word.
 *   `<scratchRepo>/.claude/agents/probe-project-agent.md` -- project-scope
 *                                  custom agent.
 *   `<scratchRepo>/.claude/skills/probe-skill/SKILL.md` -- project-scope skill.
 *   `<scratchRepo>/.claude/settings.json` -- a `PreToolUse` hook (matcher
 *                                  `Read`) that touches a hook canary file.
 *
 * OBSERVATIONS PER SESSION: `system:init`'s `mcp_servers` / `tools` /
 * `agents` / `skills`; the spawn-canary files on disk; canary-word answers
 * (asked the way `probe-sdk-instruction-loading.ts` does); post-turn
 * `Query.mcpServerStatus()`.
 *
 * ARMS (owner-directed order: A first, reported alone; then C, B, F; then
 * E/D/G if budget allows). Default (no arm flag) = all seven, in this
 * order -- operationally this probe is run across SEVERAL invocations
 * (A alone; then C+B+F together; then E/D/G if budget remains), selecting
 * arms explicitly each time, per the owner directive that A's result must
 * be reported before C starts.
 *
 *   --armA  `['user']`, strict OFF (+ `A+` settingSources omitted positive
 *           control, `A-` `[]` negative control [P0's shape], `A2` `['user']`
 *           + strict ON). 4 sessions. Hoped: U+L start, X+Y don't; user
 *           CLAUDE.md loads, project CLAUDE.md+rules don't; user agent
 *           appears in `agents`, project agent doesn't.
 *   --armC  `['user','project']`, strict OFF (X,Y,U starting = baseline).
 *           C1 `allowedMcpServers:[{X, exact argv}]`, C2 same with one arg
 *           mutated (the hash-equivalence test), C3 `allowedMcpServers: []`,
 *           C5 `deniedMcpServers:[{Y}]` -- each run through BOTH the
 *           `managedSettings` carrier (C1-3/C5) and the `settings` carrier
 *           (C4's "C1-C3 via Options.settings", extended here to C5 too for
 *           carrier symmetry) = 1 baseline + 4 variants x 2 carriers = 9
 *           sessions. Expected, stated first: the managedSettings ALLOW
 *           variants (C1,C2,C3) are dropped -> same as baseline (the doc's
 *           permissive-array-silently-dropped rule); the managedSettings
 *           DENY variant (C5) survives (a restrictive key). The settings-
 *           carrier variants have NO documented expectation -- pure
 *           measurement, though the literal field semantics (an allowlist
 *           allows only named servers; an empty allowlist allows none; a
 *           denylist blocks the named server) are recorded as the
 *           HYPOTHESIS a deviation is measured against.
 *   --armB  `['user','project']`, strict OFF. B1 `disabledMcpjsonServers:
 *           ['X']` -> X blocked, Y starts. B2 `enabledMcpjsonServers:['Y']`
 *           only -> does X still start (an enabled-list-as-record, not a
 *           gate, would say yes)? B3 `enableAllProjectMcpServers: false`.
 *           Baseline reused from arm C (identical `settingSources`/strict).
 *           3 sessions.
 *   --armF  `['user','project']` + `claudeMdExcludes:['**\/CLAUDE.md',
 *           '**\/.claude/rules/**']` -> X,Y start but CLAUDE.md/rules
 *           canary words do NOT appear. F-control (no excludes, canaries DO
 *           appear) + F1 (settings carrier) + F1m (managedSettings
 *           carrier) = 3 sessions. Records native skills/agents loading
 *           here too (should be unaffected by the excludes -- they gate
 *           CLAUDE.md/rules content only).
 *   --armE  (optional) `['project']` + the repo hook. E-control: one `Read`
 *           fires the hook canary. E2: `disableAllHooks: true` -> it does
 *           not. 2 sessions.
 *   --armD  (optional, lowest priority) strict OFF +
 *           `disableClaudeAiConnectors: true` -> the four claude.ai
 *           connectors disappear. Control reused from arm C's baseline
 *           reading (already shows them present, matching section 4.2's P0
 *           finding) rather than re-billing a session for it. 1 session.
 *   --armG  (optional, cheap) explicit `Options.mcpServers` with the
 *           stdio-echo fixture's `args` containing the literal string
 *           `${PROBE_VAR}`, and a real `PROBE_VAR` env value set on the
 *           server config -- does the reported argv show the literal or
 *           the expanded value? Control = the same via `.mcp.json` (project
 *           file scope). 2 sessions. Docs say expanded.
 *
 * EXIT CODES (`PROBE_EXIT`): 0 = every selected arm produced a definite
 * measurement (a deviation from a stated expectation is a MEASUREMENT,
 * printed as a `STOP:` line, not a failure of this script); 1 =
 * INCONCLUSIVE for at least one selected arm (a control failed, a turn did
 * not settle); 2 = HARNESS. `--max-usd <n>` (default 3) halts the run
 * before starting a session that would push the running total over budget;
 * a halted run can never report MEASURED (same `finalExitCode` shape as
 * the sibling probe).
 *
 * MUST NOT (mechanically enforced where possible, disciplined elsewhere):
 * no production code / schema / docs changes from this script; no change
 * to the sibling probe's existing arms (only its two named exports were
 * added); no write to the operator's real config dir (`isolateClaudeConfigDir`
 * + `verifyIsolation`, same as every sibling probe); no call to any
 * connector's tool; a failed control halts that arm's dependents, never
 * silently continues past it; stdio canary servers are killed at teardown
 * (the `claude` child's own exit takes its MCP subprocess children with it;
 * teardown additionally verifies no canary-server PID from this run remains).
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user; a User-scope `chrome-devtools` MCP server in `~/.claude.json`
 * (reused from the sibling probe's own precondition, since this probe seeds
 * the SAME reserved-pair regression control via the SAME
 * `readUserScopeMcpServers`/`startAgentConsoleStandIn` exports); `bun
 * install` already run. BILLABLE. A manual gate, never a CI job; registered
 * in `.claude/rules/test-trigger.md`.
 *
 * Usage: bun scripts/smoke/probe-sdk-mcp-settings-sources.ts [--armA] [--armC] [--armB] [--armF] [--armE] [--armD] [--armG] [--max-usd <n>]
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { McpServerConfig, Options, Settings } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  turnSettled,
  verifyIsolation,
  type SystemInitMessage,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';
import { readUserScopeMcpServers, startAgentConsoleStandIn } from './probe-sdk-declared-mcp-and-task.js';

// ---------------------------------------------------------------------------
// Exit codes and the pure verdict layer (the part the unit test pins)
// ---------------------------------------------------------------------------

export const PROBE_EXIT = {
  MEASURED: 0,
  INCONCLUSIVE: 1,
  HARNESS: 2,
} as const;

const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.MEASURED]: 'measured; every selected arm produced a definite reading',
  [PROBE_EXIT.INCONCLUSIVE]: 'inconclusive; at least one selected arm produced no reading',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
};

export interface ArmVerdict {
  arm: string;
  conclusive: boolean;
  verdict: string;
  stops: string[];
}

export function exitCodeFor(verdicts: ReadonlyArray<Pick<ArmVerdict, 'conclusive'>>): number {
  if (verdicts.length === 0) return PROBE_EXIT.INCONCLUSIVE;
  return verdicts.every((v) => v.conclusive) ? PROBE_EXIT.MEASURED : PROBE_EXIT.INCONCLUSIVE;
}

/** A halted run (budget or a P0-shaped control failure) can never claim MEASURED. */
export function finalExitCode(pushedVerdicts: ReadonlyArray<Pick<ArmVerdict, 'conclusive'>>, halted: boolean): number {
  const code = exitCodeFor(pushedVerdicts);
  return halted && code === PROBE_EXIT.MEASURED ? PROBE_EXIT.INCONCLUSIVE : code;
}

// ---------------------------------------------------------------------------
// Server names, canary directory layout
// ---------------------------------------------------------------------------

/** User-scope (U) and local-scope (L) server names, declared in `<configDir>/.claude.json`. */
export const USER_SERVER = 'probe-user-mcp';
export const LOCAL_SERVER = 'probe-local-mcp';
/** Project-scope (X, Y) server names, declared in `<scratchRepo>/.mcp.json`. */
export const PROJECT_SERVER_X = 'probe-project-x';
export const PROJECT_SERVER_Y = 'probe-project-y';
/** Explicit-`Options.mcpServers` arm-G server name. */
export const EXPLICIT_SERVER_G = 'probe-explicit-g';

export const ALL_SERVER_NAMES = [USER_SERVER, LOCAL_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y] as const;
export type ServerName = (typeof ALL_SERVER_NAMES)[number];

export const RESERVED_MCP_SERVER_NAMES = ['agent-console', 'console'] as const;

// ---------------------------------------------------------------------------
// Init observation helpers (a smaller, purpose-built cousin of the sibling's
// InitObservation -- this probe reads `agents`/`skills` too, which the
// sibling's declared-MCP arms never needed).
// ---------------------------------------------------------------------------

export interface InitLite {
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  agents: string[];
  skills: string[];
}

export function initLite(init: SystemInitMessage | null): InitLite | null {
  if (!init) return null;
  return {
    tools: [...init.tools],
    mcpServers: init.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
    agents: [...(init.agents ?? [])],
    skills: [...(init.skills ?? [])],
  };
}

export function mcpStatus(init: InitLite, name: string): string | null {
  return init.mcpServers.find((s) => s.name === name)?.status ?? null;
}

export function hasMcp(init: InitLite, name: string): boolean {
  return init.mcpServers.some((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Arm A -- settingSources: ['user'] and its controls
// ---------------------------------------------------------------------------

export type ArmALabel = 'A' | 'A+' | 'A-' | 'A2';

export interface ArmASessionReading {
  label: ArmALabel;
  settled: boolean;
  init: InitLite | null;
  /** Spawn-canary file existence, keyed by server name. */
  spawned: Record<ServerName, boolean>;
  /** Canary-word detection, one per instruction source. */
  canaries: { userClaudeMd: boolean; projectClaudeMd: boolean; unscopedRule: boolean };
}

export interface ArmAExpectation {
  spawned: Record<ServerName, boolean>;
  canaries: { userClaudeMd: boolean; projectClaudeMd: boolean; unscopedRule: boolean };
  agents: { user: boolean; project: boolean };
}

/** The AC's stated "hoped" shape per arm-A session label. */
export function expectedForArmA(label: ArmALabel): ArmAExpectation {
  switch (label) {
    case 'A':
      return {
        spawned: { [USER_SERVER]: true, [LOCAL_SERVER]: true, [PROJECT_SERVER_X]: false, [PROJECT_SERVER_Y]: false } as Record<ServerName, boolean>,
        canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
        agents: { user: true, project: false },
      };
    case 'A+':
      return {
        spawned: { [USER_SERVER]: true, [LOCAL_SERVER]: true, [PROJECT_SERVER_X]: true, [PROJECT_SERVER_Y]: true } as Record<ServerName, boolean>,
        canaries: { userClaudeMd: true, projectClaudeMd: true, unscopedRule: true },
        agents: { user: true, project: true },
      };
    case 'A-':
      return {
        spawned: { [USER_SERVER]: false, [LOCAL_SERVER]: false, [PROJECT_SERVER_X]: false, [PROJECT_SERVER_Y]: false } as Record<ServerName, boolean>,
        canaries: { userClaudeMd: false, projectClaudeMd: false, unscopedRule: false },
        agents: { user: false, project: false },
      };
    case 'A2':
      // Strict blocks MCP for the 'user' scope specifically (L2059's
      // "ignoring ... user settings"); CLAUDE.md / agents are NOT MCP
      // config, so the 'user' settingSource's non-MCP content is expected
      // to load exactly as in plain arm A.
      return {
        spawned: { [USER_SERVER]: false, [LOCAL_SERVER]: false, [PROJECT_SERVER_X]: false, [PROJECT_SERVER_Y]: false } as Record<ServerName, boolean>,
        canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
        agents: { user: true, project: false },
      };
  }
}

/**
 * One session's verdict. Always conclusive once settled (a deviation from
 * "hoped" is a MEASUREMENT, not a script failure) -- `stops` carries
 * deviations on the MCP-containment axis specifically, since that is the
 * load-bearing safety property this arm exists to check; canary-word /
 * agent-visibility deviations are recorded in the verdict text as findings
 * for the design doc, not escalated to `stops`.
 */
export function classifyArmASession(r: ArmASessionReading): ArmVerdict {
  const arm = r.label;
  if (!r.settled || !r.init) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  }
  const expected = expectedForArmA(r.label);
  const spawnedMismatch = ALL_SERVER_NAMES.filter((n) => r.spawned[n] !== expected.spawned[n]);
  const mcpNameMismatch = ALL_SERVER_NAMES.filter((n) => hasMcp(r.init!, n) !== expected.spawned[n]);
  const canaryMismatch = (Object.keys(expected.canaries) as Array<keyof typeof expected.canaries>).filter(
    (k) => r.canaries[k] !== expected.canaries[k],
  );
  const agentUser = r.init.agents.includes('probe-user-agent');
  const agentProject = r.init.agents.includes('probe-project-agent');
  const skillPresent = r.init.skills.includes('probe-skill');
  const stops: string[] = [];
  if (spawnedMismatch.length > 0 || mcpNameMismatch.length > 0) {
    stops.push(
      `armA[${arm}] MCP containment deviated from hoped shape -- spawnedMismatch=${JSON.stringify(spawnedMismatch)} mcpNameMismatch=${JSON.stringify(mcpNameMismatch)}`,
    );
  }
  return {
    arm,
    conclusive: true,
    verdict:
      `spawned=${JSON.stringify(r.spawned)} (expected ${JSON.stringify(expected.spawned)}, deviates=${JSON.stringify(spawnedMismatch)}); ` +
      `mcp_servers=${JSON.stringify(r.init.mcpServers)}; ` +
      `canaries=${JSON.stringify(r.canaries)} (expected ${JSON.stringify(expected.canaries)}, deviates=${JSON.stringify(canaryMismatch)}); ` +
      `agents: user=${agentUser} (expected ${expected.agents.user}) project=${agentProject} (expected ${expected.agents.project}), full=${JSON.stringify(r.init.agents)}; ` +
      `skills: probe-skill=${skillPresent} (recorded, not asserted), full=${JSON.stringify(r.init.skills)}`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Arm C -- the managedSettings/settings "wall"
// ---------------------------------------------------------------------------

export type CVariant = 'baseline' | 'C1' | 'C2' | 'C3' | 'C5';
export type Carrier = 'managedSettings' | 'settings';

export interface ArmCSessionReading {
  variant: CVariant;
  carrier: Carrier | 'n/a';
  settled: boolean;
  init: InitLite | null;
  spawned: { U: boolean; X: boolean; Y: boolean };
}

/**
 * The hypothesis a settings-carrier reading is measured against: literal
 * field semantics (an allow-array admits only its named servers; empty
 * admits none; a deny-array blocks its named server), since `Options.settings`
 * is not documented as a restrictive-filtered policy tier the way
 * `Options.managedSettings` is.
 */
function literalCVariantExpectation(variant: CVariant): { U: boolean; X: boolean; Y: boolean } | null {
  switch (variant) {
    case 'baseline':
      return { U: true, X: true, Y: true };
    case 'C1':
      return { U: false, X: true, Y: false };
    case 'C2':
      // Mutated argv -- the allow-array's entry no longer matches X at all,
      // so literal semantics says NOTHING is allowed (X included).
      return { U: false, X: false, Y: false };
    case 'C3':
      return { U: false, X: false, Y: false };
    case 'C5':
      return { U: true, X: true, Y: false };
  }
}

/** The AC's stated managedSettings-carrier expectation: ALLOW variants dropped (== baseline), DENY variant survives. */
function managedCVariantExpectation(variant: CVariant): { U: boolean; X: boolean; Y: boolean } {
  if (variant === 'C5') return { U: true, X: true, Y: false }; // restrictive key: survives
  return { U: true, X: true, Y: true }; // permissive key: dropped -> same as baseline
}

export function classifyArmCSession(r: ArmCSessionReading): ArmVerdict {
  const arm = r.carrier === 'n/a' ? r.variant : `${r.variant}-${r.carrier}`;
  if (!r.settled || !r.init) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  }
  const stops: string[] = [];
  let expectationLine = '';
  if (r.variant === 'baseline') {
    const expected = literalCVariantExpectation('baseline')!;
    const deviates = (['U', 'X', 'Y'] as const).filter((k) => r.spawned[k] !== expected[k]);
    if (deviates.length > 0) {
      stops.push(`armC[baseline] regression control deviated -- expected ${JSON.stringify(expected)}, measured ${JSON.stringify(r.spawned)} (deviates=${JSON.stringify(deviates)})`);
    }
    expectationLine = `baseline expected=${JSON.stringify(expected)}`;
  } else if (r.carrier === 'managedSettings') {
    const expected = managedCVariantExpectation(r.variant);
    const deviates = (['U', 'X', 'Y'] as const).filter((k) => r.spawned[k] !== expected[k]);
    if (deviates.length > 0) {
      stops.push(
        `armC[${arm}] managedSettings deviated from the doc's restrictive-only-filter claim -- expected ${JSON.stringify(expected)}, measured ${JSON.stringify(r.spawned)} (deviates=${JSON.stringify(deviates)})`,
      );
    }
    expectationLine = `managedSettings doc-expected=${JSON.stringify(expected)} (${r.variant === 'C5' ? 'restrictive key, should survive' : 'permissive key, should be dropped -> same as baseline'})`;
  } else {
    const hypothesis = literalCVariantExpectation(r.variant);
    expectationLine = `settings-carrier UNDOCUMENTED -- literal-semantics hypothesis=${JSON.stringify(hypothesis)}, no stop raised on deviation`;
  }
  return {
    arm,
    conclusive: true,
    verdict: `spawned=${JSON.stringify(r.spawned)}; mcp_servers=${JSON.stringify(r.init.mcpServers)}; ${expectationLine}`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Arm B -- native project-gate semantics
// ---------------------------------------------------------------------------

export type BVariant = 'B1' | 'B2' | 'B3';

export interface ArmBSessionReading {
  variant: BVariant;
  settled: boolean;
  init: InitLite | null;
  spawned: { X: boolean; Y: boolean };
}

export function classifyArmBSession(r: ArmBSessionReading): ArmVerdict {
  const arm = r.variant;
  if (!r.settled || !r.init) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  }
  // B1 has a stated expectation (X blocked, Y starts). B2/B3 are open
  // questions in the AC ("does X still start?" / "effect?") -- recorded as
  // measurements, no stop on either outcome.
  const stops: string[] = [];
  if (r.variant === 'B1') {
    const expected = { X: false, Y: true };
    if (r.spawned.X !== expected.X || r.spawned.Y !== expected.Y) {
      stops.push(`armB[B1] disabledMcpjsonServers did not block the named server as documented -- expected ${JSON.stringify(expected)}, measured ${JSON.stringify(r.spawned)}`);
    }
  }
  return {
    arm,
    conclusive: true,
    verdict: `spawned=${JSON.stringify(r.spawned)}; mcp_servers=${JSON.stringify(r.init.mcpServers)}`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Arm F -- claudeMdExcludes feasibility (design III input)
// ---------------------------------------------------------------------------

export type FVariant = 'control' | 'F1-settings' | 'F1-managedSettings';

export interface ArmFSessionReading {
  variant: FVariant;
  settled: boolean;
  init: InitLite | null;
  spawned: { X: boolean; Y: boolean };
  canaries: { projectClaudeMd: boolean; unscopedRule: boolean };
}

export function classifyArmFSession(r: ArmFSessionReading): ArmVerdict {
  const arm = r.variant;
  if (!r.settled || !r.init) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  }
  const stops: string[] = [];
  if (r.variant === 'control') {
    if (!r.canaries.projectClaudeMd || !r.canaries.unscopedRule) {
      stops.push(`armF[control] canaries did not load with no excludes present -- measured ${JSON.stringify(r.canaries)}`);
    }
  } else {
    // Feasibility claim: X/Y still start (excludes only gate CLAUDE.md/rules
    // content, not MCP scope), and the canaries are suppressed.
    if (!r.spawned.X || !r.spawned.Y) {
      stops.push(`armF[${arm}] claudeMdExcludes unexpectedly suppressed MCP loading too -- spawned=${JSON.stringify(r.spawned)}`);
    }
    if (r.canaries.projectClaudeMd || r.canaries.unscopedRule) {
      stops.push(`armF[${arm}] claudeMdExcludes did NOT suppress the canaries -- design III's premise is FALSE for this carrier -- measured ${JSON.stringify(r.canaries)}`);
    }
  }
  return {
    arm,
    conclusive: true,
    verdict: `spawned=${JSON.stringify(r.spawned)}; canaries=${JSON.stringify(r.canaries)}; agents=${JSON.stringify(r.init.agents)}; skills=${JSON.stringify(r.init.skills)}`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Arm E -- hooks under settingSources: ['project']
// ---------------------------------------------------------------------------

export type EVariant = 'control' | 'disableAllHooks';

export interface ArmESessionReading {
  variant: EVariant;
  settled: boolean;
  hookFired: boolean;
}

export function classifyArmESession(r: ArmESessionReading): ArmVerdict {
  const arm = r.variant;
  if (!r.settled) return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle', stops: [] };
  const expected = r.variant === 'control';
  const stops: string[] = [];
  if (r.hookFired !== expected) {
    stops.push(`armE[${arm}] hook firing deviated -- expected hookFired=${expected}, measured=${r.hookFired}`);
  }
  return { arm, conclusive: true, verdict: `hookFired=${r.hookFired} (expected ${expected})`, stops };
}

// ---------------------------------------------------------------------------
// Arm D -- disableClaudeAiConnectors
// ---------------------------------------------------------------------------

export interface ArmDReading {
  settled: boolean;
  init: InitLite | null;
  /** From the reused arm-C baseline reading. */
  controlConnectorNames: string[];
}

export function classifyArmD(r: ArmDReading): ArmVerdict {
  const arm = 'D';
  if (!r.settled || !r.init) return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  if (r.controlConnectorNames.length === 0) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- reused control reading showed no connectors present, so this arm has nothing to test disappearance against', stops: [] };
  }
  const subjectNames = r.init.mcpServers.map((s) => s.name);
  const stillPresent = r.controlConnectorNames.filter((n) => subjectNames.includes(n));
  const stops: string[] = [];
  if (stillPresent.length > 0) {
    stops.push(`armD disableClaudeAiConnectors did not remove: ${JSON.stringify(stillPresent)}`);
  }
  return {
    arm,
    conclusive: true,
    verdict: `control connectors=${JSON.stringify(r.controlConnectorNames)}; subject mcp_servers=${JSON.stringify(subjectNames)}; stillPresent=${JSON.stringify(stillPresent)}`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Arm G -- env-var expansion in declared server args
// ---------------------------------------------------------------------------

export type GVariant = 'explicit' | 'projectFile';

export interface ArmGSessionReading {
  variant: GVariant;
  settled: boolean;
  /** The last argv element the fixture reported back, or null if the tool was never called / turn produced nothing usable. */
  reportedTag: string | null;
  literalTag: string;
  expandedTag: string;
}

export function classifyArmGSession(r: ArmGSessionReading): ArmVerdict {
  const arm = r.variant;
  if (!r.settled || r.reportedTag === null) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or the tool was never called', stops: [] };
  }
  const expanded = r.reportedTag === r.expandedTag;
  const literal = r.reportedTag === r.literalTag;
  const stops: string[] = [];
  if (!expanded && !literal) {
    stops.push(`armG[${arm}] reported tag matched neither the literal nor the expanded form -- reportedTag=${JSON.stringify(r.reportedTag)}`);
  }
  return {
    arm,
    conclusive: true,
    verdict: `reportedTag=${JSON.stringify(r.reportedTag)} expanded=${expanded} literal=${literal} (docs say expanded)`,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing -- inside main() only (import-safety guard)
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--armA', '--armC', '--armB', '--armF', '--armE', '--armD', '--armG'] as const;
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-mcp-settings-sources.ts [--armA] [--armC] [--armB] [--armF] [--armE] [--armD] [--armG] [--max-usd <n>]\n' +
  '  Default (no arm flag) = all seven, in owner-directed order (A, C, B, F, E, D, G). Operationally run across several invocations: A alone first, its result reported, then the rest.';

function parseArgs(argv: string[]): { arms: Set<string>; maxUsd: number } {
  const arms = new Set<string>();
  let maxUsd = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((ARM_FLAGS as readonly string[]).includes(a)) {
      arms.add(a);
      continue;
    }
    if (a === '--max-usd') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`${USAGE_TEXT}\n  --max-usd requires a positive number`);
        process.exit(PROBE_EXIT.HARNESS);
      }
      maxUsd = v;
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (arms.size === 0) for (const f of ARM_FLAGS) arms.add(f);
  return { arms, maxUsd };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const FIXTURE_PATH = resolve(import.meta.dir, 'fixtures/stdio-echo-mcp-server.ts');
const PROBE_TOKEN = 'probe-1781-token';

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

interface Canaries {
  userClaudeMd: string;
  projectClaudeMd: string;
  unscopedRule: string;
}

interface Fixtures {
  configDir: string;
  scratchDir: string;
  canaryDir: string;
  hookCanaryPath: string;
  canaries: Canaries;
}

function stdioServerConfig(name: string, extraArgs: string[] = [], env?: Record<string, string>): McpServerConfig {
  const canaryPath = join(fixturesCanaryDir, `${name}.touched`);
  return {
    type: 'stdio',
    command: 'bun',
    args: [FIXTURE_PATH, '--canary', canaryPath, '--env-var', 'PROBE_MCP_ECHO_VAR', ...extraArgs],
    alwaysLoad: true,
    ...(env ? { env } : {}),
  };
}

// Set once by buildFixtures(); read by stdioServerConfig() above and by the
// spawn-canary reset/read helpers below.
let fixturesCanaryDir = '';

function spawnCanaryPath(name: string): string {
  return join(fixturesCanaryDir, `${name}.touched`);
}

function resetSpawnCanaries(names: readonly string[]): void {
  for (const n of names) {
    const p = spawnCanaryPath(n);
    if (existsSync(p)) unlinkSync(p);
  }
}

function readSpawnCanaries<N extends string>(names: readonly N[]): Record<N, boolean> {
  const out = {} as Record<N, boolean>;
  for (const n of names) out[n] = existsSync(spawnCanaryPath(n));
  return out;
}

/**
 * Builds the isolated `<configDir>` + scratch git repo once, shared by every
 * arm (content is read-only across arms; only the spawn-canary files and
 * hook-canary file are reset per session).
 */
function buildFixtures(): Fixtures {
  const configDir = isolateClaudeConfigDir('mcp-settings-sources');
  const scratchDir = mkdtempSync(join(tmpdir(), 'probe-sdk-mcp-settings-sources-repo-'));
  const canaryDir = mkdtempSync(join(tmpdir(), 'probe-sdk-mcp-settings-sources-canaries-'));
  fixturesCanaryDir = canaryDir;
  const hookCanaryPath = join(canaryDir, 'hook.touched');

  const canaries: Canaries = {
    userClaudeMd: nonce('CANARY-USER'),
    projectClaudeMd: nonce('CANARY-PROJECT'),
    unscopedRule: nonce('CANARY-UNSCOPED'),
  };

  // --- <configDir>: user-scope + local-scope MCP, user CLAUDE.md, user agent ---
  writeFileSync(join(configDir, 'CLAUDE.md'), `# User Instructions\n\nUser canary word: ${canaries.userClaudeMd}\n`);
  mkdirSync(join(configDir, 'agents'), { recursive: true });
  writeFileSync(
    join(configDir, 'agents', 'probe-user-agent.md'),
    '---\nname: probe-user-agent\ndescription: Probe fixture user-scope subagent (Issue #1781). Not used by real prompts.\n---\nYou are a probe fixture subagent. Do nothing unless explicitly asked.\n',
  );
  writeFileSync(
    join(configDir, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: { [USER_SERVER]: stdioServerConfig(USER_SERVER) },
        projects: {
          [scratchDir]: { mcpServers: { [LOCAL_SERVER]: stdioServerConfig(LOCAL_SERVER) } },
        },
      },
      null,
      2,
    ),
  );

  // --- scratch repo: project-scope MCP, CLAUDE.md, rules, agent, skill, hook ---
  Bun.spawnSync(['git', 'init', '-q'], { cwd: scratchDir });
  writeFileSync(join(scratchDir, 'CLAUDE.md'), `# Project Instructions\n\nProject canary word: ${canaries.projectClaudeMd}\n`);
  mkdirSync(join(scratchDir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(scratchDir, '.claude', 'rules', 'unscoped.md'), `# Unscoped Rule\n\nUnscoped-rule canary word: ${canaries.unscopedRule}\n`);
  mkdirSync(join(scratchDir, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(scratchDir, '.claude', 'agents', 'probe-project-agent.md'),
    '---\nname: probe-project-agent\ndescription: Probe fixture project-scope subagent (Issue #1781). Not used by real prompts.\n---\nYou are a probe fixture subagent. Do nothing unless explicitly asked.\n',
  );
  mkdirSync(join(scratchDir, '.claude', 'skills', 'probe-skill'), { recursive: true });
  writeFileSync(
    join(scratchDir, '.claude', 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: Probe fixture skill (Issue #1781). Not used by real prompts.\n---\nDo nothing unless explicitly invoked.\n',
  );
  writeFileSync(
    join(scratchDir, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `touch ${hookCanaryPath}` }] }],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(scratchDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          [PROJECT_SERVER_X]: stdioServerConfig(PROJECT_SERVER_X),
          [PROJECT_SERVER_Y]: stdioServerConfig(PROJECT_SERVER_Y),
        },
      },
      null,
      2,
    ),
  );

  return { configDir, scratchDir, canaryDir, hookCanaryPath, canaries };
}

function askCanaryPrompt(canaries: Canaries): string {
  const hint = (w: string) => w.split('-').slice(0, 2).join('-');
  return (
    'Do you currently know any of these three canary words: one starting with ' +
    `"${hint(canaries.userClaudeMd)}" (call it USER), one starting with "${hint(canaries.projectClaudeMd)}" (call it PROJECT), ` +
    `one starting with "${hint(canaries.unscopedRule)}" (call it UNSCOPED)? For each of the three, either quote it exactly if you ` +
    'can see it verbatim in your own context, or say "unknown" for that label if you cannot. Do not guess.'
  );
}

function detectCanaries(text: string, canaries: Canaries): { userClaudeMd: boolean; projectClaudeMd: boolean; unscopedRule: boolean } {
  return {
    userClaudeMd: text.includes(canaries.userClaudeMd),
    projectClaudeMd: text.includes(canaries.projectClaudeMd),
    unscopedRule: text.includes(canaries.unscopedRule),
  };
}

interface BatteryVariation {
  settingSources?: 'omit' | string[];
  strictMcpConfig?: boolean;
  managedSettings?: Partial<Settings>;
  settings?: Partial<Settings>;
  extraMcpServers?: Record<string, McpServerConfig>;
}

function buildOptions(cwd: string, agentConsoleUrl: string, v: BatteryVariation): Options {
  const options: Options = {
    executable: 'bun',
    cwd,
    model: MODEL,
    mcpServers: {
      'agent-console': {
        type: 'http',
        url: agentConsoleUrl,
        headers: { Authorization: `Bearer ${PROBE_TOKEN}` },
        alwaysLoad: true,
      },
      ...(v.extraMcpServers ?? {}),
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settings: { autoCompactEnabled: false, autoMemoryEnabled: false, ...(v.settings ?? {}) },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a probe subject. Follow instructions literally.' },
  };
  if (v.settingSources !== 'omit') options.settingSources = v.settingSources as Options['settingSources'];
  if (v.strictMcpConfig !== undefined) options.strictMcpConfig = v.strictMcpConfig;
  if (v.managedSettings !== undefined) options.managedSettings = v.managedSettings as Settings;
  return options;
}

function logInit(label: string, init: InitLite | null): void {
  if (!init) {
    console.log(`${label}: system:init = (none)`);
    return;
  }
  console.log(`${label}: mcp_servers = ${JSON.stringify(init.mcpServers)}`);
  console.log(`${label}: agents = ${JSON.stringify(init.agents)}`);
  console.log(`${label}: skills = ${JSON.stringify(init.skills)}`);
}

interface SessionRun {
  init: InitLite | null;
  outcome: TurnOutcome;
  session: ProbeSession;
}

async function runOneSession(
  label: string,
  cwd: string,
  agentConsoleUrl: string,
  variation: BatteryVariation,
  prompt: string,
  turnTimeoutMs = 240_000,
): Promise<SessionRun> {
  const session = new ProbeSession({ label, options: buildOptions(cwd, agentConsoleUrl, variation), pollUsage: false });
  const ready = await session.waitForReady();
  console.log(`${label}: ready=${ready}`);
  const outcome = await session.runTurn(prompt, turnTimeoutMs);
  account(label, outcome);
  console.log(turnLine(label, outcome));
  const init = initLite(session.systemInit);
  logInit(label, init);
  session.close();
  await session.waitForStreamEnd();
  return { init, outcome, session };
}

const PONG_PROMPT = 'Reply with exactly the single word: pong';

// ---------------------------------------------------------------------------
// Budget gate
// ---------------------------------------------------------------------------

class BudgetExceeded extends Error {}

function checkBudget(maxUsd: number): void {
  if (totals().cost > maxUsd) {
    throw new BudgetExceeded(`running total $${totals().cost.toFixed(4)} exceeds --max-usd ${maxUsd}`);
  }
}

// ---------------------------------------------------------------------------
// Arm A
// ---------------------------------------------------------------------------

async function runArmASession(label: ArmALabel, f: Fixtures, url: string, settingSources: 'omit' | string[], strictMcpConfig?: boolean): Promise<ArmVerdict> {
  resetSpawnCanaries(ALL_SERVER_NAMES);
  const run = await runOneSession(`armA-${label}`, f.scratchDir, url, { settingSources, strictMcpConfig }, askCanaryPrompt(f.canaries));
  const spawned = readSpawnCanaries(ALL_SERVER_NAMES);
  const settled = turnSettled(run.outcome);
  const canaries = settled ? detectCanaries(run.outcome.text, f.canaries) : { userClaudeMd: false, projectClaudeMd: false, unscopedRule: false };
  console.log(`armA-${label}: spawned=${JSON.stringify(spawned)} canaries=${JSON.stringify(canaries)}`);
  return classifyArmASession({ label, settled, init: settled ? run.init : null, spawned, canaries });
}

async function armA(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM A -- settingSources: [\'user\'] and controls (A, A+, A-, A2)');
  const verdicts: ArmVerdict[] = [];
  verdicts.push(await runArmASession('A', f, url, ['user']));
  checkBudget(maxUsd);
  verdicts.push(await runArmASession('A+', f, url, 'omit'));
  checkBudget(maxUsd);
  verdicts.push(await runArmASession('A-', f, url, []));
  checkBudget(maxUsd);
  verdicts.push(await runArmASession('A2', f, url, ['user'], true));
  return verdicts;
}

// ---------------------------------------------------------------------------
// Arm C
// ---------------------------------------------------------------------------

function exactArgvFor(name: string): [string, ...string[]] {
  const cfg = stdioServerConfig(name) as { command: string; args: string[] };
  return [cfg.command, ...cfg.args] as [string, ...string[]];
}

function cVariantPayload(variant: Exclude<CVariant, 'baseline'>): Partial<Settings> {
  switch (variant) {
    case 'C1':
      return { allowedMcpServers: [{ serverName: PROJECT_SERVER_X, serverCommand: exactArgvFor(PROJECT_SERVER_X) }] };
    case 'C2': {
      const argv = exactArgvFor(PROJECT_SERVER_X);
      const mutated = [...argv];
      mutated[mutated.length - 1] = `${mutated[mutated.length - 1]}-mutated`;
      return { allowedMcpServers: [{ serverName: PROJECT_SERVER_X, serverCommand: mutated as [string, ...string[]] }] };
    }
    case 'C3':
      return { allowedMcpServers: [] };
    case 'C5':
      return { deniedMcpServers: [{ serverName: PROJECT_SERVER_Y }] };
  }
}

async function runArmCSession(variant: CVariant, carrier: Carrier | 'n/a', f: Fixtures, url: string): Promise<{ verdict: ArmVerdict; init: InitLite | null }> {
  resetSpawnCanaries([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const battery: BatteryVariation = { settingSources: ['user', 'project'], strictMcpConfig: false };
  if (variant !== 'baseline') {
    const payload = cVariantPayload(variant);
    if (carrier === 'managedSettings') battery.managedSettings = payload;
    else battery.settings = payload;
  }
  const label = carrier === 'n/a' ? `armC-${variant}` : `armC-${variant}-${carrier}`;
  const run = await runOneSession(label, f.scratchDir, url, battery, PONG_PROMPT);
  const settled = turnSettled(run.outcome);
  const spawned = readSpawnCanaries([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const reading: ArmCSessionReading = {
    variant,
    carrier,
    settled,
    init: settled ? run.init : null,
    spawned: { U: spawned[USER_SERVER], X: spawned[PROJECT_SERVER_X], Y: spawned[PROJECT_SERVER_Y] },
  };
  console.log(`${label}: spawned=U:${reading.spawned.U} X:${reading.spawned.X} Y:${reading.spawned.Y}`);
  const verdict = classifyArmCSession(reading);
  console.log(`${label} verdict: ${verdict.verdict}`);
  return { verdict, init: settled ? run.init : null };
}

async function armC(f: Fixtures, url: string, maxUsd: number): Promise<{ verdicts: ArmVerdict[]; baselineInit: InitLite | null }> {
  h('ARM C -- the managedSettings/settings wall (baseline + C1,C2,C3,C5 x {managedSettings, settings})');
  const verdicts: ArmVerdict[] = [];
  const baseline = await runArmCSession('baseline', 'n/a', f, url);
  verdicts.push(baseline.verdict);
  checkBudget(maxUsd);
  for (const variant of ['C1', 'C2', 'C3', 'C5'] as const) {
    for (const carrier of ['managedSettings', 'settings'] as const) {
      const { verdict } = await runArmCSession(variant, carrier, f, url);
      verdicts.push(verdict);
      checkBudget(maxUsd);
    }
  }
  return { verdicts, baselineInit: baseline.init };
}

// ---------------------------------------------------------------------------
// Arm B
// ---------------------------------------------------------------------------

function bVariantSettings(variant: BVariant): Partial<Settings> {
  switch (variant) {
    case 'B1':
      return { disabledMcpjsonServers: [PROJECT_SERVER_X] };
    case 'B2':
      return { enabledMcpjsonServers: [PROJECT_SERVER_Y] };
    case 'B3':
      return { enableAllProjectMcpServers: false };
  }
}

async function runArmBSession(variant: BVariant, f: Fixtures, url: string): Promise<ArmVerdict> {
  resetSpawnCanaries([PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const run = await runOneSession(
    `armB-${variant}`,
    f.scratchDir,
    url,
    { settingSources: ['user', 'project'], strictMcpConfig: false, settings: bVariantSettings(variant) },
    PONG_PROMPT,
  );
  const settled = turnSettled(run.outcome);
  const spawned = readSpawnCanaries([PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const verdict = classifyArmBSession({ variant, settled, init: settled ? run.init : null, spawned: { X: spawned[PROJECT_SERVER_X], Y: spawned[PROJECT_SERVER_Y] } });
  console.log(`armB-${variant} verdict: ${verdict.verdict}`);
  return verdict;
}

async function armB(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM B -- native project-gate semantics (B1, B2, B3)');
  const verdicts: ArmVerdict[] = [];
  for (const variant of ['B1', 'B2', 'B3'] as const) {
    verdicts.push(await runArmBSession(variant, f, url));
    checkBudget(maxUsd);
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Arm F
// ---------------------------------------------------------------------------

const CLAUDE_MD_EXCLUDES = ['**/CLAUDE.md', '**/.claude/rules/**'];

async function runArmFSession(variant: FVariant, f: Fixtures, url: string): Promise<ArmVerdict> {
  resetSpawnCanaries([PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const battery: BatteryVariation = { settingSources: ['user', 'project'], strictMcpConfig: false };
  if (variant === 'F1-settings') battery.settings = { claudeMdExcludes: CLAUDE_MD_EXCLUDES };
  if (variant === 'F1-managedSettings') battery.managedSettings = { claudeMdExcludes: CLAUDE_MD_EXCLUDES };
  const run = await runOneSession(`armF-${variant}`, f.scratchDir, url, battery, askCanaryPrompt(f.canaries));
  const settled = turnSettled(run.outcome);
  const spawned = readSpawnCanaries([PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const canaries = settled ? detectCanaries(run.outcome.text, f.canaries) : { userClaudeMd: false, projectClaudeMd: false, unscopedRule: false };
  const verdict = classifyArmFSession({
    variant,
    settled,
    init: settled ? run.init : null,
    spawned: { X: spawned[PROJECT_SERVER_X], Y: spawned[PROJECT_SERVER_Y] },
    canaries: { projectClaudeMd: canaries.projectClaudeMd, unscopedRule: canaries.unscopedRule },
  });
  console.log(`armF-${variant} verdict: ${verdict.verdict}`);
  return verdict;
}

async function armF(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM F -- claudeMdExcludes feasibility (design III input)');
  const verdicts: ArmVerdict[] = [];
  for (const variant of ['control', 'F1-settings', 'F1-managedSettings'] as const) {
    verdicts.push(await runArmFSession(variant, f, url));
    checkBudget(maxUsd);
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Arm E
// ---------------------------------------------------------------------------

const READ_TARGET_PROMPT = 'Use your Read tool to read the file CLAUDE.md in your current working directory, then reply with exactly the single word DONE.';

async function runArmESession(variant: EVariant, f: Fixtures, url: string): Promise<ArmVerdict> {
  if (existsSync(f.hookCanaryPath)) unlinkSync(f.hookCanaryPath);
  const battery: BatteryVariation = { settingSources: ['project'], settings: variant === 'disableAllHooks' ? { disableAllHooks: true } : {} };
  const run = await runOneSession(`armE-${variant}`, f.scratchDir, url, battery, READ_TARGET_PROMPT);
  const settled = turnSettled(run.outcome);
  const hookFired = existsSync(f.hookCanaryPath);
  const verdict = classifyArmESession({ variant, settled, hookFired });
  console.log(`armE-${variant} verdict: ${verdict.verdict}`);
  return verdict;
}

async function armE(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM E (optional) -- hooks under settingSources: [\'project\']');
  const verdicts: ArmVerdict[] = [];
  verdicts.push(await runArmESession('control', f, url));
  checkBudget(maxUsd);
  verdicts.push(await runArmESession('disableAllHooks', f, url));
  return verdicts;
}

// ---------------------------------------------------------------------------
// Arm D
// ---------------------------------------------------------------------------

function connectorNamesFrom(init: InitLite | null): string[] {
  if (!init) return [];
  return init.mcpServers.map((s) => s.name).filter((n) => !RESERVED_MCP_SERVER_NAMES.includes(n as never) && n.toLowerCase().includes('claude'));
}

async function armD(f: Fixtures, url: string, baselineInit: InitLite | null): Promise<ArmVerdict> {
  h('ARM D (optional) -- disableClaudeAiConnectors');
  const run = await runOneSession(
    'armD',
    f.scratchDir,
    url,
    { settingSources: ['user', 'project'], strictMcpConfig: false, settings: { disableClaudeAiConnectors: true } },
    PONG_PROMPT,
  );
  const settled = turnSettled(run.outcome);
  const verdict = classifyArmD({ settled, init: settled ? run.init : null, controlConnectorNames: connectorNamesFrom(baselineInit) });
  console.log(`armD verdict: ${verdict.verdict}`);
  return verdict;
}

// ---------------------------------------------------------------------------
// Arm G
// ---------------------------------------------------------------------------

async function runArmGSession(variant: GVariant, f: Fixtures, url: string, literalTag: string, envValue: string): Promise<ArmVerdict> {
  const battery: BatteryVariation =
    variant === 'explicit'
      ? { settingSources: ['user', 'project'], extraMcpServers: { [EXPLICIT_SERVER_G]: stdioServerConfig(EXPLICIT_SERVER_G, [literalTag], { PROBE_VAR: envValue }) } }
      : { settingSources: ['user', 'project'] };
  const serverName = variant === 'explicit' ? EXPLICIT_SERVER_G : PROJECT_SERVER_X;
  const run = await runOneSession(
    `armG-${variant}`,
    f.scratchDir,
    url,
    battery,
    `Call the tool named mcp__${serverName}__probe_echo exactly once with no arguments, then reply with ONLY its exact JSON text output and nothing else.`,
  );
  const settled = turnSettled(run.outcome);
  let reportedTag: string | null = null;
  if (settled) {
    try {
      const parsed = JSON.parse(run.outcome.text.trim()) as { argv: string[] };
      reportedTag = parsed.argv[parsed.argv.length - 1] ?? null;
    } catch {
      reportedTag = null;
    }
  }
  const verdict = classifyArmGSession({ variant, settled, reportedTag, literalTag, expandedTag: envValue });
  console.log(`armG-${variant} verdict: ${verdict.verdict} (raw answer: ${JSON.stringify(run.outcome.text.trim().slice(0, 300))})`);
  return verdict;
}

async function armG(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM G (optional) -- env-var expansion in declared server args');
  const envValue = `probe-g-expanded-${nonce('VAL')}`;
  const literalTag = '${PROBE_VAR}';
  const verdicts: ArmVerdict[] = [];
  verdicts.push(await runArmGSession('explicit', f, url, literalTag, envValue));
  checkBudget(maxUsd);
  // The project-file control needs the SAME literal placeholder + env value
  // reachable via the process env the CLI inherits, since `.mcp.json`
  // cannot carry a per-server `env` block distinct from the explicit-option
  // path's own config in this probe's harness -- set it on this process's
  // own env before spawning, matching how a real project `.mcp.json` server
  // would only see `${PROBE_VAR}` if the CLI's OWN process environment (not
  // the SDK's `Options.mcpServers` entry) carries it.
  process.env.PROBE_VAR = envValue;
  try {
    verdicts.push(await runArmGSession('projectFile', f, url, literalTag, envValue));
  } finally {
    delete process.env.PROBE_VAR;
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { arms, maxUsd } = parseArgs(process.argv.slice(2));
  const userServers = readUserScopeMcpServers();
  const standIn = await startAgentConsoleStandIn();
  const f = buildFixtures();
  h(`probe-sdk-mcp-settings-sources -- arms=${[...arms].join(' ')} maxUsd=${maxUsd} config=${f.configDir} scratch=${f.scratchDir} canaries=${f.canaryDir}`);
  console.log(`user-scope mcpServers seeded via readUserScopeMcpServers(): ${JSON.stringify(Object.keys(userServers))} (unused by this probe's own servers; kept only as the sibling precondition check)`);

  const verdicts: ArmVerdict[] = [];
  let halted: string | null = null;
  let baselineInit: InitLite | null = null;
  try {
    if (arms.has('--armA')) verdicts.push(...(await armA(f, standIn.url, maxUsd)));
    if (arms.has('--armC')) {
      const c = await armC(f, standIn.url, maxUsd);
      verdicts.push(...c.verdicts);
      baselineInit = c.baselineInit;
    }
    if (arms.has('--armB')) verdicts.push(...(await armB(f, standIn.url, maxUsd)));
    if (arms.has('--armF')) verdicts.push(...(await armF(f, standIn.url, maxUsd)));
    if (arms.has('--armE')) verdicts.push(...(await armE(f, standIn.url, maxUsd)));
    if (arms.has('--armD')) verdicts.push(await armD(f, standIn.url, baselineInit));
    if (arms.has('--armG')) verdicts.push(...(await armG(f, standIn.url, maxUsd)));
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      halted = err.message;
      console.log(`HALTED (budget): ${halted}`);
    } else {
      throw err;
    }
  } finally {
    standIn.stop();
  }

  h('ISOLATION');
  const iso = verifyIsolation(f.configDir);
  console.log(`config dir ${f.configDir}: evidence=${JSON.stringify(iso.evidence)} transcripts=${iso.files.length}`);
  const harnessFailed = !iso.ok;
  if (harnessFailed) {
    console.log('HARNESS: the CLAUDE_CONFIG_DIR override did not reach the child; every isolation claim above is void');
  }

  h('VERDICTS');
  for (const v of verdicts) {
    console.log(`${v.arm}: ${v.verdict}`);
    for (const s of v.stops) console.log(`STOP: ${s}`);
  }
  if (halted) console.log(`HALTED: ${halted}`);
  const t = totals();
  console.log(`\nturns=${perTurn.size} promptTokens=${t.tokens} cost=$${t.cost.toFixed(4)} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);

  try {
    rmSync(f.scratchDir, { recursive: true, force: true });
    rmSync(f.canaryDir, { recursive: true, force: true });
  } catch {
    // Scratch dirs; leaving them behind is harmless.
  }

  if (harnessFailed) return PROBE_EXIT.HARNESS;
  const code = finalExitCode(verdicts, halted !== null);
  console.log(`exit ${code}: ${EXIT_CODE_MEANINGS[code]}`);
  return code;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`HARNESS: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(PROBE_EXIT.HARNESS);
    });
}
