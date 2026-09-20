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
import { createSdkMcpServer, type McpServerConfig, type Options, type Settings } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { McpServer } from '../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js';
import { SDK_COMPACT_TOOL_NAME, createSdkCompactTool, createSdkTodoWriteTool } from '../../packages/embedded-agent/src/sdk-engine.js';
import { SDK_TODO_WRITE_TOOL_NAME } from '../../packages/shared/src/types/embedded-agent.ts';
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
/**
 * Project-FILE (`.mcp.json`) arm-G server name -- distinct from X/Y, and
 * declared with its OWN `${PROBE_VAR}`-bearing `args` entry, so arm G's
 * `projectFile` control actually exercises the same expansion question as
 * `explicit` rather than reusing X's plain declaration (which never carried
 * the placeholder argument at all).
 */
export const PROJECT_FILE_SERVER_G = 'probe-project-file-g';
/** G3 (project-file-scope env/headers/url expansion): distinct server names, all declared in `.mcp.json`. */
export const G3_ENV_SERVER = 'probe-g3-env';
export const G3_HEADERS_SERVER = 'probe-g3-headers';
export const G3_URL_SERVER = 'probe-g3-url';

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

export type ArmALabel = 'A' | 'A+' | 'A-' | 'A2' | 'A3';

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
    case 'A3':
      // Orchestrator/Architect addendum (2026-09-20), added after plain arm
      // A measured that 'user' alone does NOT cover local-scope MCP (L).
      // The load-bearing question for design II: does 'local' ALSO leak in
      // project-scope (X, Y)? Expected=false here is the HOPE, not an
      // assumption -- a measured true is the finding this session exists to
      // surface, via the same MCP-containment STOP path as every other
      // label. CLAUDE.md/agent visibility is expected identical to plain A,
      // since 'local' only adds a settings/MCP source, not a different
      // user-scope loader.
      return {
        spawned: { [USER_SERVER]: true, [LOCAL_SERVER]: true, [PROJECT_SERVER_X]: false, [PROJECT_SERVER_Y]: false } as Record<ServerName, boolean>,
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

export type CVariant = 'baseline' | 'C1' | 'C1b' | 'C1c' | 'C2' | 'C2p' | 'C3' | 'C5';
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
    case 'C1b':
      // Diagnostic (my own addition, before reporting C1/C2/C3): a
      // NAME-ONLY allow entry (no serverCommand), isolating whether the
      // compound serverName+serverCommand entry's argv reconstruction is
      // what actually failed to match X in C1/C2/C3, rather than the field
      // doing nothing regardless of content. If this ALSO reads
      // {U:false,X:false,Y:false}, the "blocks everything regardless of
      // content" finding stands on firmer ground; if X starts here, the
      // C1/C2/C3 result is attributable to a bad serverCommand match, not
      // to the field being inert.
      return { U: false, X: true, Y: false };
    case 'C1c':
      // Orchestrator/Architect addendum: re-run of C1's exact-argv shape,
      // now with an absolute `command` path so PATH-resolution cannot be
      // the reason a match fails. Expected: X admitted (the exact-argv
      // "hash" actually works once the compared string is unambiguous).
      return { U: false, X: true, Y: false };
    case 'C2':
      // Mutated argv -- the allow-array's entry no longer matches X at all,
      // so literal semantics says NOTHING is allowed (X included).
      return { U: false, X: false, Y: false };
    case 'C2p':
      // C1c's sibling with one argv element mutated -- the hash-equivalence
      // negative: expected X now blocked, proving the exact-argv comparison
      // is sensitive to content once the base case (C1c) is known to work.
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

export type FVariant = 'control' | 'F1-settings' | 'F1-managedSettings' | 'F2-settings';

export interface ArmFSessionReading {
  variant: FVariant;
  settled: boolean;
  init: InitLite | null;
  spawned: { X: boolean; Y: boolean };
  /**
   * `userClaudeMd` is recorded for every variant but only ASSERTED for F2
   * (Architect addendum, 2026-09-20): F1's glob (`**\/CLAUDE.md`) is
   * absolute-path-matched, so it may ALSO exclude the isolated config dir's
   * own user-level CLAUDE.md -- an open question, not a stop, for F1. F2's
   * point is a NARROW, project-file-only exclude that must leave user-level
   * content untouched, so a suppressed userClaudeMd there IS a stop.
   */
  canaries: { userClaudeMd: boolean; projectClaudeMd: boolean; unscopedRule: boolean };
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
  } else if (r.variant === 'F2-settings') {
    // Narrow, project-file-only exclude: X/Y unaffected (recorded, not the
    // point of F2), project CLAUDE.md suppressed, user CLAUDE.md AND the
    // unscoped rule (untouched by this narrower pattern) must survive.
    if (r.canaries.projectClaudeMd) {
      stops.push(`armF[F2-settings] the narrow project-file-only exclude did NOT suppress the project canary -- measured ${JSON.stringify(r.canaries)}`);
    }
    if (!r.canaries.userClaudeMd) {
      stops.push(`armF[F2-settings] the narrow exclude ALSO suppressed user-level CLAUDE.md -- design II cannot drop only the loader-supplied file -- measured ${JSON.stringify(r.canaries)}`);
    }
    if (!r.canaries.unscopedRule) {
      stops.push(`armF[F2-settings] the narrow exclude unexpectedly suppressed the unscoped rule too -- measured ${JSON.stringify(r.canaries)}`);
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
/**
 * `--armA3` (Orchestrator/Architect addendum, 2026-09-20) is deliberately
 * NOT part of `ARM_FLAGS`'s default population: arm A had already run and
 * been reported before A3 was requested, so it must be billable on its own
 * rather than re-running (and re-billing) the original four-session arm A.
 */
const EXTRA_FLAGS = ['--armA3', '--armC1b', '--armC1d', '--armC1e', '--armC1c', '--armG2', '--armG3'] as const;
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-mcp-settings-sources.ts [--armA] [--armA3] [--armC] [--armC1b] [--armC1d] [--armC1c] [--armB] [--armF] [--armE] [--armD] [--armG] [--max-usd <n>]\n' +
  '  Default (no arm flag) = the original seven, in owner-directed order (A, C, B, F, E, D, G). --armA3/--armC1b/--armC1d/--armC1c are addenda, explicit-only. Operationally run across several invocations: A alone first, its result reported, then the rest.';

function parseArgs(argv: string[]): { arms: Set<string>; maxUsd: number } {
  const arms = new Set<string>();
  let maxUsd = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((ARM_FLAGS as readonly string[]).includes(a) || (EXTRA_FLAGS as readonly string[]).includes(a)) {
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
  /** Arm G's project-file server: the value baked into its `.mcp.json` `env` block. */
  armGProjectFileValue: string;
}

function stdioServerConfig(name: string, extraArgs: string[] = [], env?: Record<string, string>): McpServerConfig {
  const canaryPath = join(fixturesCanaryDir, `${name}.touched`);
  return {
    type: 'stdio',
    // Orchestrator/Architect addendum (2026-09-20), after C1/C2's bare
    // `command: 'bun'` collapsed to identical "blocked" readings alongside
    // C3's empty-array control: an absolute path removes PATH-resolution
    // as a variable in the C1c/C2' exact-argv matching diagnostic, so a
    // failure to match there is attributable to the SDK's comparison
    // semantics, not to a resolvable-vs-literal command-string mismatch.
    command: process.execPath,
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
function buildFixtures(g3HeaderStandInUrl: string): Fixtures {
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
  // Arm G's project-file server: the SAME `${VAR}`-in-args shape as the
  // explicit-scope variant, so the two are actually comparable (fixing the
  // bug where the projectFile control originally reused X's plain
  // declaration, which never carried the placeholder argument at all).
  const armGProjectFileValue = `probe-g-projectfile-expanded-${nonce('VAL')}`;
  const armGLiteralTag = '${PROBE_VAR}';

  // G3 (project-file-scope version of G2): the SAME env:/headers:/url:
  // `${VAR}` shapes as G2's explicit-scope servers, declared in `.mcp.json`
  // instead of `Options.mcpServers`. `g3HeaderStandInUrl` is created by the
  // caller BEFORE this function runs (its port must be known at file-write
  // time); `${PROBE_PORT}` in the url server is expanded (or not) from
  // `armG3()`'s own process.env, exactly like G2.
  writeFileSync(
    join(scratchDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          [PROJECT_SERVER_X]: stdioServerConfig(PROJECT_SERVER_X),
          [PROJECT_SERVER_Y]: stdioServerConfig(PROJECT_SERVER_Y),
          [PROJECT_FILE_SERVER_G]: stdioServerConfig(PROJECT_FILE_SERVER_G, [armGLiteralTag], { PROBE_VAR: armGProjectFileValue }),
          [G3_ENV_SERVER]: stdioServerConfig(G3_ENV_SERVER, [], { PROBE_MCP_ECHO_VAR: '${PROBE_VAR}' }),
          [G3_HEADERS_SERVER]: {
            type: 'http',
            url: g3HeaderStandInUrl,
            headers: { 'X-Probe': 'v-${PROBE_VAR}' },
            alwaysLoad: true,
          },
          [G3_URL_SERVER]: {
            type: 'http',
            url: 'http://127.0.0.1:${PROBE_PORT}/',
            headers: { Authorization: `Bearer ${PROBE_TOKEN}` },
            alwaysLoad: true,
          },
        },
      },
      null,
      2,
    ),
  );

  return { configDir, scratchDir, canaryDir, hookCanaryPath, canaries, armGProjectFileValue };
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
      // Added for the Architect's C1d+e diagnostic (2026-09-20): production
      // parity requires the in-process 'console' server present too, so an
      // allowlist naming it can be tested for re-admission alongside the
      // HTTP-based 'agent-console' stand-in.
      console: createSdkMcpServer({
        name: 'console',
        tools: [createSdkCompactTool(() => undefined), createSdkTodoWriteTool()],
      }),
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

/**
 * A3 -- Orchestrator/Architect addendum (2026-09-20), added after plain arm
 * A measured that `settingSources: ['user']` alone does not cover
 * local-scope MCP (L). Run as its own flag (`--armA3`) so it can be billed
 * separately from the original four-session arm A, which had already run
 * and been reported before this addendum arrived.
 */
async function armA3(f: Fixtures, url: string): Promise<ArmVerdict> {
  h('ARM A3 (addendum) -- settingSources: [\'user\',\'local\']');
  return runArmASession('A3', f, url, ['user', 'local']);
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
    case 'C1b':
      return { allowedMcpServers: [{ serverName: PROJECT_SERVER_X }] };
    case 'C1c':
      // Same shape as C1, but stdioServerConfig() now emits an ABSOLUTE
      // command path (process.execPath), so exactArgvFor() reconstructs a
      // string the CLI cannot ambiguously re-resolve.
      return { allowedMcpServers: [{ serverName: PROJECT_SERVER_X, serverCommand: exactArgvFor(PROJECT_SERVER_X) }] };
    case 'C2': {
      const argv = exactArgvFor(PROJECT_SERVER_X);
      const mutated = [...argv];
      mutated[mutated.length - 1] = `${mutated[mutated.length - 1]}-mutated`;
      return { allowedMcpServers: [{ serverName: PROJECT_SERVER_X, serverCommand: mutated as [string, ...string[]] }] };
    }
    case 'C2p': {
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

/**
 * C1b diagnostic -- run standalone (`--armC1b`) so it can be billed on its
 * own after arm C already ran and showed C1/C2/C3 collapsing to the SAME
 * "everything blocked" reading under BOTH carriers, which cannot by itself
 * distinguish "the field does nothing regardless of content" from "the
 * compound serverName+serverCommand entry's argv reconstruction failed to
 * match X" (workflow.md's "a check's existence is not its detection
 * power" applied to this arm's own C1 row). A name-only allow entry
 * isolates the two: X admitted here means C1/C2/C3's result is a harness
 * argv-matching artifact, not a genuine SDK finding.
 */
async function armC1bDiagnostic(f: Fixtures, url: string): Promise<ArmVerdict[]> {
  h('ARM C1b (diagnostic) -- name-only allowedMcpServers entry, both carriers');
  const verdicts: ArmVerdict[] = [];
  for (const carrier of ['managedSettings', 'settings'] as const) {
    const { verdict } = await runArmCSession('C1b', carrier, f, url);
    verdicts.push(verdict);
  }
  return verdicts;
}

/**
 * C1c / C2' -- Orchestrator/Architect addendum (2026-09-20): pins whether
 * `serverCommand` exact-argv matching works AT ALL on this SDK version, now
 * that `command` is an absolute path (removing PATH-resolution ambiguity as
 * a candidate explanation for C1/C2's uniform "blocked" reading). Settings
 * carrier only -- C1/C1b/C2/C3/C5 already established the two carriers
 * behave identically for this field, so a second carrier here would spend a
 * turn confirming an already-measured equivalence rather than answering a
 * new question. If C1c STILL blocks X, that is itself the recorded finding
 * (exact-argv matching unusable on 0.3.238, form unknown) -- not a harness
 * failure, since the apparatus already proved it CAN admit a server (C1b).
 */
/** The connector name diagnostic C1d+e names first by its label form (not the tool-name slug), matching `system:init.mcp_servers[].name`'s observed shape. */
const DIAGNOSTIC_CONNECTOR_LABEL = 'claude.ai Google Drive';
const DIAGNOSTIC_CONNECTOR_SLUG = 'claude_ai_Google_Drive';
const DIAGNOSTIC_CONNECTOR_TOOL_PREFIX = 'mcp__claude_ai_Google_Drive__';
const OTHER_CONNECTOR_LABELS = ['claude.ai Claude Docs', 'claude.ai Google Calendar', 'claude.ai Gmail'];

/**
 * C1d+e (Architect's exact shape, 2026-09-20, sent directly -- theirs wins):
 * one session, `settings.allowedMcpServers` naming FOUR servers by
 * `serverName` alone: the reserved HTTP stand-in (`agent-console`), the
 * reserved in-process SDK server (`console`), one project-scope server (X),
 * and one claude.ai connector. Four observations recorded SEPARATELY, per
 * the Architect's spec, because a failure on (1)/(2) is the load-bearing
 * "SDK-native allowlist wall is incompatible with the reserved pair"
 * finding -- it must never be folded into a single pass/fail.
 *
 * `connectorNameForm` parameterizes obs4's naming form: the label ("claude.ai
 * Google Drive", matching `mcp_servers[].name`'s observed shape) is the
 * Architect's primary form; the slug ("claude_ai_Google_Drive") is the
 * OPTIONAL follow-up their own spec names if the label form reads absent.
 */
async function armC1dePlus(f: Fixtures, url: string, connectorNameForm: 'label' | 'slug' = 'label'): Promise<ArmVerdict> {
  const connectorName = connectorNameForm === 'label' ? DIAGNOSTIC_CONNECTOR_LABEL : DIAGNOSTIC_CONNECTOR_SLUG;
  const arm = connectorNameForm === 'label' ? 'C1d+e' : 'C1e-slug';
  h(`ARM ${arm} (Architect's shape) -- allowlist by name: agent-console, console, X, a claude.ai connector (${connectorNameForm} form)`);
  resetSpawnCanaries([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const run = await runOneSession(
    `armC-${arm}`,
    f.scratchDir,
    url,
    {
      settingSources: ['user', 'project'],
      strictMcpConfig: false,
      settings: {
        allowedMcpServers: [
          { serverName: 'agent-console' },
          { serverName: 'console' },
          { serverName: PROJECT_SERVER_X },
          { serverName: connectorName },
        ],
      },
    },
    PONG_PROMPT,
  );
  const settled = turnSettled(run.outcome);
  const spawned = readSpawnCanaries([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  if (!settled || !run.init) {
    return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
  }
  const init = run.init;
  const agentConsoleStatus = mcpStatus(init, 'agent-console');
  const consoleStatus = mcpStatus(init, 'console');
  const consoleToolsPresent = init.tools.includes(SDK_COMPACT_TOOL_NAME) && init.tools.includes(SDK_TODO_WRITE_TOOL_NAME);
  const connectorPresent = hasMcp(init, DIAGNOSTIC_CONNECTOR_LABEL) || hasMcp(init, DIAGNOSTIC_CONNECTOR_SLUG);
  const connectorToolsPresent = init.tools.some((t) => t.startsWith(DIAGNOSTIC_CONNECTOR_TOOL_PREFIX));
  const otherConnectorsPresent = OTHER_CONNECTOR_LABELS.filter((n) => hasMcp(init, n));
  const obs1 = agentConsoleStatus === 'connected';
  const obs2 = consoleStatus === 'connected' && consoleToolsPresent;
  const obs3 = spawned[PROJECT_SERVER_X] && !spawned[USER_SERVER] && !spawned[PROJECT_SERVER_Y];
  const obs4 = connectorPresent && connectorToolsPresent && otherConnectorsPresent.length === 0;
  const stops: string[] = [];
  if (!obs1 || !obs2) {
    stops.push(
      `${arm} LOAD-BEARING -- naming the reserved pair by serverName did NOT re-admit both: agent-console status=${agentConsoleStatus ?? '(absent)'} (obs1=${obs1}), console status=${consoleStatus ?? '(absent)'} tools=${consoleToolsPresent} (obs2=${obs2}). An SDK-native allowlist wall is incompatible with the reserved pair on this build.`,
    );
  }
  if (!obs3) {
    stops.push(`${arm} obs3 deviated -- spawned=${JSON.stringify(spawned)} (expected X only)`);
  }
  if (!obs4) {
    stops.push(
      `${arm} obs4 (${connectorNameForm} form) -- connector re-admission did not read as expected: present=${connectorPresent} toolsPresent=${connectorToolsPresent} otherConnectorsStillPresent=${JSON.stringify(otherConnectorsPresent)}`,
    );
  }
  return {
    arm,
    conclusive: true,
    verdict:
      `battery includes console=true; obs1(agent-console connected)=${obs1} status=${agentConsoleStatus ?? '(absent)'}; ` +
      `obs2(console connected+tools)=${obs2} status=${consoleStatus ?? '(absent)'} toolsPresent=${consoleToolsPresent}; ` +
      `obs3(X only)=${obs3} spawned=${JSON.stringify(spawned)}; ` +
      `obs4(connector re-admitted via ${connectorNameForm} form, others absent)=${obs4} present=${connectorPresent} toolsPresent=${connectorToolsPresent} otherConnectorsPresent=${JSON.stringify(otherConnectorsPresent)}; ` +
      `full mcp_servers=${JSON.stringify(init.mcpServers)}`,
    stops,
  };
}

async function armC1cDiagnostic(f: Fixtures, url: string): Promise<ArmVerdict[]> {
  h("ARM C1c/C2' (diagnostic) -- exact-argv matching with an absolute command path, settings carrier");
  const verdicts: ArmVerdict[] = [];
  const c1c = await runArmCSession('C1c', 'settings', f, url);
  verdicts.push(c1c.verdict);
  const c2p = await runArmCSession('C2p', 'settings', f, url);
  verdicts.push(c2p.verdict);
  return verdicts;
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
  // F2 (Architect addendum, 2026-09-20): a NARROW, absolute-path exclude
  // naming only the project's own CLAUDE.md -- does design II's exclude
  // knob drop just the loader-supplied file, leaving user-level CLAUDE.md
  // (and the unscoped rule, untouched by this narrower pattern) intact?
  if (variant === 'F2-settings') battery.settings = { claudeMdExcludes: [join(f.scratchDir, 'CLAUDE.md')] };
  const run = await runOneSession(`armF-${variant}`, f.scratchDir, url, battery, askCanaryPrompt(f.canaries));
  const settled = turnSettled(run.outcome);
  const spawned = readSpawnCanaries([PROJECT_SERVER_X, PROJECT_SERVER_Y]);
  const canaries = settled ? detectCanaries(run.outcome.text, f.canaries) : { userClaudeMd: false, projectClaudeMd: false, unscopedRule: false };
  const verdict = classifyArmFSession({
    variant,
    settled,
    init: settled ? run.init : null,
    spawned: { X: spawned[PROJECT_SERVER_X], Y: spawned[PROJECT_SERVER_Y] },
    canaries,
  });
  console.log(`armF-${variant} verdict: ${verdict.verdict}`);
  return verdict;
}

async function armF(f: Fixtures, url: string, maxUsd: number): Promise<ArmVerdict[]> {
  h('ARM F -- claudeMdExcludes feasibility (design III input)');
  const verdicts: ArmVerdict[] = [];
  for (const variant of ['control', 'F1-settings', 'F1-managedSettings', 'F2-settings'] as const) {
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

/**
 * `baselineInit` reuses arm C's baseline reading when this invocation ran
 * `--armC` first (avoiding a redundant billed control session). When D runs
 * standalone (its own invocation), `baselineInit` is null and this runs one
 * cheap control session itself instead of assuming a fixed connector list --
 * the connector set is empirically stable across every session observed so
 * far, but asserting that stability without re-checking would be exactly
 * the "trust a secondary signal" trap workflow.md warns about.
 */
async function armD(f: Fixtures, url: string, baselineInit: InitLite | null): Promise<ArmVerdict> {
  h('ARM D -- disableClaudeAiConnectors');
  let control = baselineInit;
  if (!control) {
    const controlRun = await runOneSession(
      'armD-control',
      f.scratchDir,
      url,
      { settingSources: ['user', 'project'], strictMcpConfig: false },
      PONG_PROMPT,
    );
    control = turnSettled(controlRun.outcome) ? controlRun.init : null;
  }
  const run = await runOneSession(
    'armD',
    f.scratchDir,
    url,
    { settingSources: ['user', 'project'], strictMcpConfig: false, settings: { disableClaudeAiConnectors: true } },
    PONG_PROMPT,
  );
  const settled = turnSettled(run.outcome);
  const verdict = classifyArmD({ settled, init: settled ? run.init : null, controlConnectorNames: connectorNamesFrom(control) });
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
  // `projectFile` uses PROJECT_FILE_SERVER_G, a DEDICATED `.mcp.json` entry
  // carrying the same `${PROBE_VAR}`-in-args shape as `explicit` (baked in
  // by buildFixtures(), env value in `f.armGProjectFileValue`) -- fixed
  // from an earlier version that reused X's plain declaration, which never
  // had the placeholder argument at all and could not have measured
  // anything about expansion.
  const serverName = variant === 'explicit' ? EXPLICIT_SERVER_G : PROJECT_FILE_SERVER_G;
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
  const literalTag = '${PROBE_VAR}';
  const verdicts: ArmVerdict[] = [];
  // Each variant compares against its OWN baked-in env value: `explicit`'s
  // is generated fresh per invocation (its server is declared inline);
  // `projectFile`'s was baked into `.mcp.json` at buildFixtures() time
  // (`f.armGProjectFileValue`), since the file is written once, before this
  // function runs.
  verdicts.push(await runArmGSession('explicit', f, url, literalTag, `probe-g-explicit-expanded-${nonce('VAL')}`));
  checkBudget(maxUsd);
  verdicts.push(await runArmGSession('projectFile', f, url, literalTag, f.armGProjectFileValue));
  return verdicts;
}

// ---------------------------------------------------------------------------
// Arm G2 -- Orchestrator's follow-up: does ${VAR} expand in env: / headers: / url:?
// ---------------------------------------------------------------------------

const G2_ENV_SERVER = 'probe-g2-env';
const G2_HEADERS_SERVER = 'probe-g2-headers';
const G2_URL_SERVER = 'probe-g2-url';

/**
 * A minimal HTTP MCP stand-in that records the last-seen value of a named
 * request header, for the `headers:` sub-observation. Mirrors the sibling
 * probe's `startAgentConsoleStandIn` construction (a fresh server+transport
 * per request, since a stateless `WebStandardStreamableHTTPServerTransport`
 * cannot be reused across requests -- see that function's own header for
 * the measured crash this avoids).
 */
async function startHeaderCapturingStandIn(headerName: string): Promise<{ url: string; stop: () => void; lastValue: () => string | null }> {
  let last: string | null = null;
  const handleRequest = (req: Request): Promise<Response> => {
    last = req.headers.get(headerName);
    const server = new McpServer({ name: 'probe-g2-headers', version: '0.0.0-probe' });
    server.registerTool('probe_ping', { description: 'Probe stand-in; replies pong.' }, async () => ({
      content: [{ type: 'text' as const, text: 'pong' }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    return server.connect(transport).then(() => transport.handleRequest(req));
  };
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handleRequest });
  return { url: `http://127.0.0.1:${srv.port}/`, stop: () => srv.stop(true), lastValue: () => last };
}

/**
 * G2 (Orchestrator's exact shape, 2026-09-20): ONE session, explicit
 * `Options.mcpServers` path only, testing THREE `${VAR}`-expansion surfaces
 * at once: a stdio server's `env:` value, an HTTP server's `headers:`
 * value, and an HTTP server's `url:` value (port number). Each has its own
 * control in the SAME session: the g2-env fixture starting normally is
 * proof positive the battery itself works; the header-capturing stand-in
 * records whatever it actually received (there is no "failure" shape for a
 * header -- the request either carries the literal or the expanded string,
 * always); the g2-url server's CONNECTION STATUS is the observable for
 * that one (a literal `${PROBE_PORT}` is not a valid host:port, so it must
 * fail to connect; the expanded real port must connect, and reaching the
 * SAME stand-in the reserved `agent-console` entry already targets is the
 * built-in positive control there).
 */
async function armG2(f: Fixtures, url: string): Promise<ArmVerdict> {
  h("ARM G2 (Orchestrator's follow-up) -- ${VAR} expansion in env:/headers:/url:, explicit mcpServers only");
  const probeVarValue = `probe-g2-env-expanded-${nonce('VAL')}`;
  const headerLiteralOrExpanded = `v-\${PROBE_VAR}`;
  const agentConsolePort = new URL(url).port;
  const headerStandIn = await startHeaderCapturingStandIn('x-probe');
  process.env.PROBE_VAR = probeVarValue;
  process.env.PROBE_PORT = agentConsolePort;
  try {
    const battery: BatteryVariation = {
      settingSources: ['user', 'project'],
      extraMcpServers: {
        // The fixture's `envVarName` is fixed to `PROBE_MCP_ECHO_VAR` by
        // `stdioServerConfig()`'s own `--env-var` arg (not parameterized
        // here) -- the `env:` key under test MUST be that exact name, or
        // the fixture reports `envValue: null` for a key that was never
        // set, which is a harness bug, not a measurement (fixed after the
        // first G2 run reported "UNKNOWN" for a mismatched key `PROBE_TOKEN`).
        [G2_ENV_SERVER]: stdioServerConfig(G2_ENV_SERVER, [], { PROBE_MCP_ECHO_VAR: '${PROBE_VAR}' }),
        [G2_HEADERS_SERVER]: {
          type: 'http',
          url: headerStandIn.url,
          headers: { 'X-Probe': headerLiteralOrExpanded },
          alwaysLoad: true,
        },
        [G2_URL_SERVER]: {
          type: 'http',
          url: 'http://127.0.0.1:${PROBE_PORT}/',
          headers: { Authorization: `Bearer ${PROBE_TOKEN}` },
          alwaysLoad: true,
        },
      },
    };
    // The fixture's tool returns a FLAT object -- {argv, envVarName,
    // envValue} (stdio-echo-mcp-server.ts's own JSON.stringify call), never
    // a nested "env" object -- ask for `envValue` directly.
    const run = await runOneSession(
      'armG2',
      f.scratchDir,
      url,
      battery,
      `Call the tool named mcp__${G2_ENV_SERVER}__probe_echo exactly once with no arguments. It returns a JSON object with an "envValue" field; reply with ONLY the exact string value of that field, and nothing else. If envValue is null, reply with exactly UNKNOWN.`,
    );
    const settled = turnSettled(run.outcome);
    if (!settled || !run.init) {
      return { arm: 'G2', conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
    }
    const init = run.init;
    // All three declared servers set `alwaysLoad: true`, which blocks
    // startup until connected/failed (capped at the standard 5s connect
    // timeout) -- `system:init` therefore already carries each one's FINAL
    // status, with no need for a post-turn `mcpServerStatus()` poll (which
    // would also require reading before `runOneSession`'s own
    // `session.close()`, not after).
    const statusOf = (name: string): string | null => mcpStatus(init, name);
    const envStatus = statusOf(G2_ENV_SERVER);
    const headersStatus = statusOf(G2_HEADERS_SERVER);
    const urlStatus = statusOf(G2_URL_SERVER);
    const reportedEnvValue = run.outcome.text.trim();
    const envExpanded = reportedEnvValue === probeVarValue;
    const envLiteral = reportedEnvValue === '${PROBE_VAR}';
    const capturedHeader = headerStandIn.lastValue();
    const headerExpanded = capturedHeader === `v-${probeVarValue}`;
    const headerLiteral = capturedHeader === headerLiteralOrExpanded;
    const urlExpanded = urlStatus === 'connected';
    const controlOk = envStatus === 'connected' && statusOf('agent-console') === 'connected';
    const stops: string[] = [];
    if (!controlOk) {
      stops.push(`G2 control failed -- g2-env status=${envStatus ?? '(absent)'}, agent-console status=${statusOf('agent-console') ?? '(absent)'}; readings below are not trustworthy`);
    }
    if (!envExpanded && !envLiteral) {
      stops.push(`G2 env: reported value matched neither form -- reportedEnvValue=${JSON.stringify(reportedEnvValue)}`);
    }
    if (!headerExpanded && !headerLiteral) {
      stops.push(`G2 headers: captured value matched neither form -- capturedHeader=${JSON.stringify(capturedHeader)}`);
    }
    return {
      arm: 'G2',
      conclusive: true,
      verdict:
        `controlOk=${controlOk}; ` +
        `env: reportedValue=${JSON.stringify(reportedEnvValue)} expanded=${envExpanded} literal=${envLiteral}; ` +
        `headers: capturedValue=${JSON.stringify(capturedHeader)} expanded=${headerExpanded} literal=${headerLiteral}; ` +
        `url: status=${urlStatus ?? '(absent)'} expanded(connected)=${urlExpanded}; ` +
        `mcp_servers=${JSON.stringify(init.mcpServers)}`,
      stops,
    };
  } finally {
    delete process.env.PROBE_VAR;
    delete process.env.PROBE_PORT;
    headerStandIn.stop();
  }
}

/**
 * G3 (Orchestrator's follow-up, 2026-09-20) -- the `.mcp.json`-path sibling
 * of G2: the SAME env:/headers:/url: `${VAR}` shapes, declared in the
 * project file instead of `Options.mcpServers`. The three G3 servers were
 * baked into `.mcp.json` by `buildFixtures()` (their `g3HeaderStandInUrl`
 * is created by `main()` BEFORE that call, since the header stand-in's
 * port must be known at file-write time); this function only sets the two
 * env vars the CLI needs to expand `${PROBE_VAR}`/`${PROBE_PORT}` from ITS
 * OWN inherited environment, runs one session, and reads the same three
 * observables G2 reads.
 */
async function armG3(f: Fixtures, url: string, g3HeaderStandIn: { lastValue: () => string | null }): Promise<ArmVerdict> {
  h("ARM G3 (Orchestrator's follow-up) -- ${VAR} expansion in env:/headers:/url:, .mcp.json path only");
  const probeVarValue = `probe-g3-env-expanded-${nonce('VAL')}`;
  const agentConsolePort = new URL(url).port;
  process.env.PROBE_VAR = probeVarValue;
  process.env.PROBE_PORT = agentConsolePort;
  try {
    const run = await runOneSession(
      'armG3',
      f.scratchDir,
      url,
      { settingSources: ['user', 'project'] },
      `Call the tool named mcp__${G3_ENV_SERVER}__probe_echo exactly once with no arguments. It returns a JSON object with an "envValue" field; reply with ONLY the exact string value of that field, and nothing else. If envValue is null, reply with exactly UNKNOWN.`,
    );
    const settled = turnSettled(run.outcome);
    if (!settled || !run.init) {
      return { arm: 'G3', conclusive: false, verdict: 'INCONCLUSIVE -- turn did not settle or no system:init', stops: [] };
    }
    const init = run.init;
    const statusOf = (name: string): string | null => mcpStatus(init, name);
    const envStatus = statusOf(G3_ENV_SERVER);
    const reportedEnvValue = run.outcome.text.trim();
    const envExpanded = reportedEnvValue === probeVarValue;
    const envLiteral = reportedEnvValue === '${PROBE_VAR}';
    const capturedHeader = g3HeaderStandIn.lastValue();
    const headerExpanded = capturedHeader === `v-${probeVarValue}`;
    const headerLiteral = capturedHeader === 'v-${PROBE_VAR}';
    const urlStatus = statusOf(G3_URL_SERVER);
    const urlExpanded = urlStatus === 'connected';
    const controlOk = envStatus === 'connected' && statusOf('agent-console') === 'connected';
    const stops: string[] = [];
    if (!controlOk) {
      stops.push(`G3 control failed -- g3-env status=${envStatus ?? '(absent)'}, agent-console status=${statusOf('agent-console') ?? '(absent)'}; readings below are not trustworthy`);
    }
    if (!envExpanded && !envLiteral) {
      stops.push(`G3 env: reported value matched neither form -- reportedEnvValue=${JSON.stringify(reportedEnvValue)}`);
    }
    if (!headerExpanded && !headerLiteral) {
      stops.push(`G3 headers: captured value matched neither form -- capturedHeader=${JSON.stringify(capturedHeader)}`);
    }
    return {
      arm: 'G3',
      conclusive: true,
      verdict:
        `controlOk=${controlOk}; ` +
        `env: reportedValue=${JSON.stringify(reportedEnvValue)} expanded=${envExpanded} literal=${envLiteral}; ` +
        `headers: capturedValue=${JSON.stringify(capturedHeader)} expanded=${headerExpanded} literal=${headerLiteral}; ` +
        `url: status=${urlStatus ?? '(absent)'} expanded(connected)=${urlExpanded}; ` +
        `mcp_servers=${JSON.stringify(init.mcpServers)}`,
      stops,
    };
  } finally {
    delete process.env.PROBE_VAR;
    delete process.env.PROBE_PORT;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { arms, maxUsd } = parseArgs(process.argv.slice(2));
  const userServers = readUserScopeMcpServers();
  const standIn = await startAgentConsoleStandIn();
  // Created before buildFixtures() -- G3's `.mcp.json` entry needs this
  // stand-in's real port at file-write time, unlike G2's, which is declared
  // inline at session-build time (its own function creates its stand-in).
  const g3HeaderStandIn = await startHeaderCapturingStandIn('x-probe');
  const f = buildFixtures(g3HeaderStandIn.url);
  h(`probe-sdk-mcp-settings-sources -- arms=${[...arms].join(' ')} maxUsd=${maxUsd} config=${f.configDir} scratch=${f.scratchDir} canaries=${f.canaryDir}`);
  console.log(`user-scope mcpServers seeded via readUserScopeMcpServers(): ${JSON.stringify(Object.keys(userServers))} (unused by this probe's own servers; kept only as the sibling precondition check)`);

  const verdicts: ArmVerdict[] = [];
  let halted: string | null = null;
  let baselineInit: InitLite | null = null;
  try {
    if (arms.has('--armA')) verdicts.push(...(await armA(f, standIn.url, maxUsd)));
    if (arms.has('--armA3')) {
      verdicts.push(await armA3(f, standIn.url));
      checkBudget(maxUsd);
    }
    if (arms.has('--armC')) {
      const c = await armC(f, standIn.url, maxUsd);
      verdicts.push(...c.verdicts);
      baselineInit = c.baselineInit;
    }
    if (arms.has('--armC1b')) {
      verdicts.push(...(await armC1bDiagnostic(f, standIn.url)));
      checkBudget(maxUsd);
    }
    if (arms.has('--armC1d')) {
      verdicts.push(await armC1dePlus(f, standIn.url));
      checkBudget(maxUsd);
    }
    if (arms.has('--armC1e')) {
      verdicts.push(await armC1dePlus(f, standIn.url, 'slug'));
      checkBudget(maxUsd);
    }
    if (arms.has('--armC1c')) {
      verdicts.push(...(await armC1cDiagnostic(f, standIn.url)));
      checkBudget(maxUsd);
    }
    if (arms.has('--armB')) verdicts.push(...(await armB(f, standIn.url, maxUsd)));
    if (arms.has('--armF')) verdicts.push(...(await armF(f, standIn.url, maxUsd)));
    if (arms.has('--armE')) verdicts.push(...(await armE(f, standIn.url, maxUsd)));
    if (arms.has('--armD')) verdicts.push(await armD(f, standIn.url, baselineInit));
    if (arms.has('--armG')) verdicts.push(...(await armG(f, standIn.url, maxUsd)));
    if (arms.has('--armG2')) {
      verdicts.push(await armG2(f, standIn.url));
      checkBudget(maxUsd);
    }
    if (arms.has('--armG3')) {
      verdicts.push(await armG3(f, standIn.url, g3HeaderStandIn));
      checkBudget(maxUsd);
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      halted = err.message;
      console.log(`HALTED (budget): ${halted}`);
    } else {
      throw err;
    }
  } finally {
    standIn.stop();
    g3HeaderStandIn.stop();
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
