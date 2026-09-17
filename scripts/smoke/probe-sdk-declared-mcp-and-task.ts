#!/usr/bin/env bun
/**
 * Task 0 premise probe for epic #1636 Phase 5 (decision 3: declared external
 * MCP servers + `Task` on the `claude-sdk` arm; Issue #1726). Measurement
 * only -- this script changes no production behavior and is not wired into
 * CI, the same class of tool as `probe-sdk-effort-live-apply.ts` and
 * `probe-sdk-auto-memory.ts`. The design section it feeds is
 * `docs/design/embedded-agent-sdk-engine.md` section 4.5.
 *
 * WHAT IT MEASURES, and why none of it can be read off the types. Every arm
 * builds the EXACT option battery `sdk-engine.ts`'s `buildOptions()` builds
 * (`permissionMode: 'bypassPermissions'`, `settingSources: []`, the
 * `tools:` allowlist derived from the shipped `claude-sdk` builtin's
 * `enabledTools`, the two existing `mcpServers` under their reserved names
 * `agent-console` / `console`, the `claude_code` preset with an append, the
 * same `settings`), then varies ONE thing, and reads the SDK's own
 * `system:init` message -- its `tools: string[]` and `mcp_servers: { name,
 * status }[]` fields (`sdk.d.ts` L4782-4785) -- plus `Query.mcpServerStatus()`
 * after the turn, plus hook firings. The vendored `sdk.d.ts` documents
 * `strictMcpConfig`, `agents`, and `AgentDefinition.tools?` ("If omitted,
 * inherits all tools from parent"), but documents NOTHING about what a
 * subagent inherits under our `tools:` allowlist + `bypassPermissions`, and
 * section 4.2's leak table was measured against `.mcp.json`, not against the
 * user-scope `~/.claude.json` config a `claude mcp add -s user` writes to.
 * Those are premises to measure, not cite.
 *
 * THE FOUR ARMS (default = all four, in this order):
 *
 *   --p0  BASELINE. Today's battery UNCHANGED, against a config dir seeded
 *         with the operator's own user-scope `mcpServers` block (see "P0's
 *         seeding", below). Records every `mcp_servers` entry and every
 *         `mcp__`-prefixed name in `tools` that is NOT one of the two
 *         reserved names. Any such entry is a PRE-EXISTING LEAK: an ambient
 *         user-scope MCP server reaching every claude-sdk worker today,
 *         invisible to the containment check because of the `mcp__`
 *         exemption in `handleSystemInit` -- a finding independent of Phase
 *         5, to be filed on its own. POSITIVE CONTROL in the same arm: the
 *         same battery with `settingSources` OMITTED (the SDK default, which
 *         section 4.2's table records as loading user config) MUST show the
 *         seeded server; if it does not, the instrument cannot see the class
 *         of thing P0 is looking for and P0 is INCONCLUSIVE rather than
 *         "no leak" (workflow.md sub-pattern 9).
 *
 *   --p1  STRICT. Battery + `strictMcpConfig: true` (`sdk.d.ts` L2058-2063:
 *         "Only use MCP servers passed via the `mcpServers` option ...
 *         ignoring ... user settings"). Expected: `mcp_servers` names ==
 *         exactly {agent-console, console}; `console` connected and its
 *         `mcp__console__Compact` / `mcp__console__TodoWrite` tools present
 *         (the REGRESSION CONTROL -- strict mode must not drop our own
 *         in-process server); `agent-console`'s status recorded by NAME
 *         (see "The `agent-console` stand-in", below).
 *
 *   --p2  DECLARED. P1 + ONE declared stdio server: the host's own
 *         `chrome-devtools` entry, copied verbatim (command/args/env) from
 *         the operator's `~/.claude.json` -- the same source `claude mcp get
 *         chrome-devtools` prints. Expected: its `mcp_servers` status is
 *         `connected` (init and/or post-turn), whether `mcp__chrome-devtools__*`
 *         names appear in `system:init`'s `tools` is RECORDED (declared
 *         servers are NOT `alwaysLoad`, so their tools may be deferred
 *         behind tool search -- the containment detector's input, so this
 *         cell is design-relevant either way), and ONE real tool call
 *         (`mcp__chrome-devtools__list_pages`) is observed STRUCTURALLY via
 *         the `PostToolUse` hook inside a turn that completes. NEGATIVE
 *         CONTROL in the same run: a second declared server named
 *         `missing-command` whose `command` does not exist -> status
 *         `failed`, no `mcp__missing-command__*` tool, and the turn still
 *         completes (declares, does not brick) -- compared to P1's baseline
 *         BY NAME, never by "any failed status".
 *
 *   --p3  TASK. Two halves, one session each.
 *         (a) P1 + `tools: [...baseline, 'Task', 'Agent']` and NO `agents`.
 *             Both names are passed because this pinned CLI silently DROPS an
 *             unrecognized `tools:` entry (section 4.1's `TodoWrite`
 *             measurement) and the vendored `sdk.d.ts` calls the same tool
 *             "the Task tool" and "the Agent tool" in adjacent comments --
 *             whichever name `system:init` reports back is the honored one,
 *             and that name is itself a finding (it is the literal D3's
 *             picklist would have to carry). Then one turn asks the model to
 *             delegate a trivial read to a subagent. Observables, structured
 *             first: `SubagentStart` hook firings (a subagent RAN), every
 *             `PreToolUse` firing carrying `agent_id` (which tools the child
 *             actually USED -- `sdk.d.ts` L177: "Present only when the hook
 *             fires from within a subagent"), and `tool_use` blocks with
 *             `parent_tool_use_id` set. The child is asked, via the nonce
 *             file it must `Read`, to list its tools and -- if it has one --
 *             to run `echo PROBE_BASH_OK` with `Bash`. The parent allowlist
 *             has NO `Bash`, so a `PreToolUse` firing of `Bash` with an
 *             `agent_id` is the structural proof that subagent containment
 *             is broken (a STOP-and-report finding); the child's prose list
 *             is recorded as the secondary, cross-check observable.
 *         (b) The same, plus `agents: { probe: { description, prompt,
 *             tools: ['Read'] } }` and the delegation prompt naming
 *             `subagent_type: 'probe'`: the child's tool set must be the
 *             declared subset -- any `agent_id`-bearing firing of a tool
 *             other than `Read` is the finding.
 *
 * P0's SEEDING, and why it is a recorded proxy. Every arm runs under
 * `isolateClaudeConfigDir` + `verifyIsolation`, exactly like its siblings,
 * so no transcript ever lands in the operator's real `~/.claude`. But an
 * isolated dir starts with NO user-scope MCP config, so an unseeded P0 would
 * read "no leak" for the wrong reason (the class of thing was absent, not
 * suppressed). The probe therefore copies ONLY the `mcpServers` block of the
 * operator's real `~/.claude.json` into the isolated dir's `.claude.json`
 * before P0 and P1 (verified free of cost beforehand: `CLAUDE_CONFIG_DIR=<seeded>
 * claude mcp get chrome-devtools` reports the User-scope entry). This is
 * upstream of and outside the chain under test (the SDK's own config
 * discovery under a given `settingSources`), it is provisioned from the real
 * file rather than hand-written, and it is recorded here and beside the
 * result in section 4.5 -- pre-pr-completeness Q13's three conditions.
 *
 * THE `agent-console` STAND-IN, the second recorded proxy. Production's
 * `agent-console` entry is an HTTP MCP server the console serves with a
 * per-worker bearer token. There is no console behind this probe, so the
 * probe stands up a minimal REAL Streamable-HTTP MCP server in its own
 * process (`@modelcontextprotocol/sdk`'s `McpServer` over `Bun.serve`, one
 * `probe_ping` tool) and points the `agent-console` entry at it with the same
 * `type: 'http'`, `headers.Authorization`, `alwaysLoad: true` shape. What is
 * substituted is the console's dial-back endpoint; what stays production-real
 * is the declaration shape, `strictMcpConfig`, and the SDK's connection
 * handling. Its status is compared BY NAME in every arm.
 *
 * VERDICTS AND EXIT CODES (`PROBE_EXIT`): 0 = every selected arm produced a
 * definite measurement (whatever it measured -- a leak in P0 or a broken
 * subagent containment in P3 is a MEASUREMENT, printed as a `STOP:` line,
 * not a failure of this script); 1 = INCONCLUSIVE for at least one selected
 * arm (a control failed, a turn did not settle, an observable never
 * arrived); 2 = HARNESS (bad arguments, unverified isolation, a missing host
 * precondition such as no `chrome-devtools` in `~/.claude.json`, an
 * exception escaping `main`). `--continue-after-leak` is required to run
 * P2/P3 in the same invocation after P0 observed a leak: a live leak changes
 * P2's negative-control design and must be reported first.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user; a User-scope `chrome-devtools` MCP server in `~/.claude.json`
 * (P0's seed and P2's declared server); `bun install` already run. BILLABLE
 * -- about 8 small turns across the four arms. A manual gate, never a CI
 * job; registered in `.claude/rules/test-trigger.md`.
 *
 * Usage: bun scripts/smoke/probe-sdk-declared-mcp-and-task.ts [--p0] [--p1] [--p2] [--p3] [--continue-after-leak]
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  type HookCallbackMatcher,
  type McpServerConfig,
  type McpServerStatus,
  type Options,
  type SyncHookJSONOutput,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { McpServer } from '../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js';
import {
  SDK_COMPACT_TOOL_NAME,
  createSdkCompactTool,
  createSdkTodoWriteTool,
} from '../../packages/embedded-agent/src/sdk-engine.js';
import { SDK_TODO_WRITE_TOOL_NAME } from '../../packages/shared/src/types/embedded-agent.ts';
import { claudeSdkAgent } from '../../packages/server/src/services/embedded-agents/claude-sdk-builtin.ts';
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

// ---------------------------------------------------------------------------
// Exit codes and the pure verdict layer (the part the unit test pins)
// ---------------------------------------------------------------------------

export const PROBE_EXIT = {
  /** Every selected arm produced a definite measurement. */
  MEASURED: 0,
  /** At least one selected arm could not be read (control failed, turn unsettled). */
  INCONCLUSIVE: 1,
  /** Harness failure -- nothing about the SDK was measured. */
  HARNESS: 2,
} as const;

const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.MEASURED]: 'measured; every selected arm produced a definite reading',
  [PROBE_EXIT.INCONCLUSIVE]: 'inconclusive; at least one selected arm produced no reading',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
};

export interface ArmVerdict {
  arm: 'P0' | 'P1' | 'P2' | 'P3a' | 'P3b';
  conclusive: boolean;
  verdict: string;
  /** Findings that change a design or need their own Issue; printed as `STOP:` lines. */
  stops: string[];
}

/**
 * Exit code for a set of arm verdicts. Deliberately simpler than
 * `probe-sdk-effort-live-apply.ts`'s four-way mapping: this probe measures
 * several independent premises, none of which is "the" premise whose
 * refutation deserves its own code, so a STOP finding is a MEASUREMENT
 * (exit 0, with the `STOP:` line) and only an unread arm is exit 1. The empty
 * set is INCONCLUSIVE for the same reason its sibling gives: exit 0 would
 * claim a measurement nobody made.
 */
export function exitCodeFor(verdicts: ReadonlyArray<Pick<ArmVerdict, 'conclusive'>>): number {
  if (verdicts.length === 0) return PROBE_EXIT.INCONCLUSIVE;
  return verdicts.every((v) => v.conclusive) ? PROBE_EXIT.MEASURED : PROBE_EXIT.INCONCLUSIVE;
}

/** The two `mcpServers` names `buildOptions()` always declares. */
export const RESERVED_MCP_SERVER_NAMES = ['agent-console', 'console'] as const;

/**
 * Server-name prefix of the executing account's claude.ai connectors
 * (section 4.1's accepted class, measured present under `settingSources: []`
 * on three SDK versions). HYPOTHESIS about the naming, taken from this
 * host's own interactive tool catalog (`mcp__claude_ai_Google_Drive__*`,
 * `mcp__claude_ai_Claude_Docs__*`); every arm prints the raw `mcp_servers`
 * names so a connector that does not match this prefix is visible as an
 * "ambient" entry rather than silently misfiled.
 */
export const ACCOUNT_CONNECTOR_PREFIX = 'claude_ai_';

export function isAccountConnector(serverName: string): boolean {
  return serverName.startsWith(ACCOUNT_CONNECTOR_PREFIX);
}

/** `system:init`'s two observable fields, as this probe reads them. */
export interface InitObservation {
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
}

/** `mcp__<server>__<tool>` -> `<server>`, or `null` for a non-MCP name. */
export function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__(.+?)__/.exec(toolName);
  return m ? m[1] : null;
}

export interface BaselineReading {
  /** `mcp_servers` names outside the reserved pair and outside the account-connector class. */
  undeclaredServers: string[];
  /** `mcp__` tool names whose server is outside the reserved pair and outside the account-connector class. */
  undeclaredMcpTools: string[];
  /** The account-connector class (section 4.1): recorded, never counted as the P0 leak. */
  accountConnectorServers: string[];
  accountConnectorTools: string[];
  leak: boolean;
}

/**
 * P0's reading of one `system:init`: anything MCP-shaped that is neither a
 * reserved name nor an account connector. Pure, so the leak/no-leak decision
 * is pinned without a billed run.
 */
export function classifyBaseline(
  init: InitObservation,
  reserved: readonly string[] = RESERVED_MCP_SERVER_NAMES,
): BaselineReading {
  const foreignServers = init.mcpServers.map((s) => s.name).filter((n) => !reserved.includes(n));
  const foreignTools = init.tools.filter((t) => {
    const server = mcpServerOf(t);
    return server !== null && !reserved.includes(server);
  });
  const undeclaredServers = foreignServers.filter((n) => !isAccountConnector(n));
  const undeclaredMcpTools = foreignTools.filter((t) => !isAccountConnector(mcpServerOf(t) ?? ''));
  return {
    undeclaredServers,
    undeclaredMcpTools,
    accountConnectorServers: foreignServers.filter(isAccountConnector),
    accountConnectorTools: foreignTools.filter((t) => isAccountConnector(mcpServerOf(t) ?? '')),
    leak: undeclaredServers.length > 0 || undeclaredMcpTools.length > 0,
  };
}

/**
 * P0's verdict from its two sessions: the positive control (settingSources
 * omitted) must SEE the seeded ambient server, or nothing the subject
 * session says about it is a reading.
 */
export function classifyP0(
  subject: InitObservation | null,
  control: InitObservation | null,
  ambientName: string,
): ArmVerdict {
  if (!control || !subject) {
    return {
      arm: 'P0',
      conclusive: false,
      verdict: `INCONCLUSIVE -- ${!control ? 'control' : 'subject'} session produced no system:init`,
      stops: [],
    };
  }
  const controlSees =
    control.mcpServers.some((s) => s.name === ambientName) ||
    control.tools.some((t) => mcpServerOf(t) === ambientName);
  if (!controlSees) {
    return {
      arm: 'P0',
      conclusive: false,
      verdict: `INCONCLUSIVE -- positive control (settingSources omitted) did not see the seeded ${ambientName}; the instrument cannot see this class`,
      stops: [],
    };
  }
  const reading = classifyBaseline(subject);
  if (reading.leak) {
    const what = [
      reading.undeclaredServers.length > 0 ? `mcp_servers ${JSON.stringify(reading.undeclaredServers)}` : null,
      reading.undeclaredMcpTools.length > 0 ? `tools ${JSON.stringify(reading.undeclaredMcpTools)}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return {
      arm: 'P0',
      conclusive: true,
      verdict: `LEAK -- today's battery (settingSources: []) reports undeclared ${what}`,
      stops: [`P0 pre-existing leak: undeclared MCP surface reaches today's claude-sdk battery (${what}); file as its own Issue`],
    };
  }
  return {
    arm: 'P0',
    conclusive: true,
    verdict: `NO LEAK -- today's battery reports ${JSON.stringify(subject.mcpServers.map((s) => s.name))} (account connectors: ${JSON.stringify(reading.accountConnectorServers)}); control saw ${ambientName}`,
    stops: [],
  };
}

export interface StrictReading {
  /** Exactly the reserved pair, once account connectors are set aside. */
  namesExact: boolean;
  /** Every name seen (init or post-turn), account connectors excluded. */
  names: string[];
  /**
   * Account connectors still reported under strict mode. Section 4.1 records
   * that no documented option suppresses this class; whether `strictMcpConfig`
   * does is a NEW cell, and it decides whether the narrowed containment
   * detector needs a carve-out for the class.
   */
  accountConnectors: string[];
  consoleConnected: boolean;
  consoleToolsPresent: boolean;
  agentConsoleStatus: string | null;
}

/**
 * P1's reading: exact reserved name set (account connectors set aside and
 * reported on their own), `console` connected with both of our in-process
 * tools present, `agent-console` reported BY NAME. `post` is
 * `Query.mcpServerStatus()` after the turn, which settles a `pending` init
 * status; the connected check accepts either source.
 */
export function classifyStrict(init: InitObservation, post: ReadonlyArray<{ name: string; status: string }>): StrictReading {
  const all = [...new Set([...init.mcpServers.map((s) => s.name), ...post.map((s) => s.name)])].sort();
  const names = all.filter((n) => !isAccountConnector(n));
  const statusOf = (name: string): string | null =>
    post.find((s) => s.name === name)?.status ?? init.mcpServers.find((s) => s.name === name)?.status ?? null;
  return {
    namesExact: names.length === 2 && names[0] === 'agent-console' && names[1] === 'console',
    names,
    accountConnectors: all.filter(isAccountConnector),
    consoleConnected: statusOf('console') === 'connected',
    consoleToolsPresent: init.tools.includes(SDK_COMPACT_TOOL_NAME) && init.tools.includes(SDK_TODO_WRITE_TOOL_NAME),
    agentConsoleStatus: statusOf('agent-console'),
  };
}

export function classifyP1(init: InitObservation | null, post: ReadonlyArray<{ name: string; status: string }>): ArmVerdict {
  if (!init) return { arm: 'P1', conclusive: false, verdict: 'INCONCLUSIVE -- no system:init', stops: [] };
  const r = classifyStrict(init, post);
  const ok = r.namesExact && r.consoleConnected && r.consoleToolsPresent;
  return {
    arm: 'P1',
    conclusive: true,
    verdict: `${ok ? 'STRICT HOLDS' : 'STRICT DEVIATES'} -- names=${JSON.stringify(r.names)} (exact=${r.namesExact}) console=${r.consoleConnected ? 'connected' : 'NOT connected'} consoleTools=${r.consoleToolsPresent} agent-console=${r.agentConsoleStatus ?? '(absent)'} accountConnectorsUnderStrict=${JSON.stringify(r.accountConnectors)}`,
    stops: ok ? [] : ['P1 strict mode dropped or failed a reserved server -- the engine wiring in 4.5 cannot set strictMcpConfig as specified'],
  };
}

export interface DeclaredInputs {
  init: InitObservation | null;
  post: ReadonlyArray<{ name: string; status: string }>;
  declaredName: string;
  missingName: string;
  /** `PostToolUse` firings of `mcp__<declaredName>__*` on the main thread. */
  declaredToolCalls: number;
  turnSettled: boolean;
}

export function classifyP2(i: DeclaredInputs): ArmVerdict {
  if (!i.init) return { arm: 'P2', conclusive: false, verdict: 'INCONCLUSIVE -- no system:init', stops: [] };
  if (!i.turnSettled) return { arm: 'P2', conclusive: false, verdict: 'INCONCLUSIVE -- the tool-call turn did not settle', stops: [] };
  const statusOf = (name: string): string | null =>
    i.post.find((s) => s.name === name)?.status ?? i.init!.mcpServers.find((s) => s.name === name)?.status ?? null;
  const declaredStatus = statusOf(i.declaredName);
  const missingStatus = statusOf(i.missingName);
  const declaredToolsAtInit = i.init.tools.filter((t) => mcpServerOf(t) === i.declaredName).length;
  const missingToolsAtInit = i.init.tools.filter((t) => mcpServerOf(t) === i.missingName).length;
  const strict = classifyStrict(
    { tools: i.init.tools, mcpServers: i.init.mcpServers.filter((s) => s.name !== i.declaredName && s.name !== i.missingName) },
    i.post.filter((s) => s.name !== i.declaredName && s.name !== i.missingName),
  );
  const declaredOk = declaredStatus === 'connected' && i.declaredToolCalls > 0;
  const missingOk = missingStatus === 'failed' && missingToolsAtInit === 0;
  const stops: string[] = [];
  if (!missingOk) stops.push(`P2 negative control: '${i.missingName}' status=${missingStatus ?? '(absent)'} tools=${missingToolsAtInit} -- a missing command did not read as a clean, declared failure`);
  if (!strict.consoleConnected) stops.push('P2 reserved `console` server not connected alongside declared servers');
  return {
    arm: 'P2',
    conclusive: true,
    verdict: `${declaredOk ? 'DECLARED WORKS' : 'DECLARED DID NOT WORK'} -- ${i.declaredName}: status=${declaredStatus ?? '(absent)'} toolsAtInit=${declaredToolsAtInit} calls=${i.declaredToolCalls}; ${i.missingName}: status=${missingStatus ?? '(absent)'} toolsAtInit=${missingToolsAtInit} (${missingOk ? 'clean failure' : 'NOT a clean failure'}); reserved console=${strict.consoleConnected ? 'connected' : 'NOT connected'}`,
    stops,
  };
}

export interface TaskInputs {
  half: 'a' | 'b';
  init: InitObservation | null;
  /** The parent's `tools:` allowlist as passed (base + the two candidate names). */
  parentAllowlist: readonly string[];
  /** `SubagentStart` firings (agent_type values). */
  subagentStarts: string[];
  /** Tool names of `PreToolUse` firings that carried an `agent_id`. */
  childToolCalls: string[];
  /** The nonce the child had to `Read`; `true` when the parent's answer contains it. */
  nonceRelayed: boolean;
  /** Tool names the child CLAIMED in prose (`TOOL:` lines relayed by the parent). */
  childClaimedTools: string[];
  turnSettled: boolean;
  /** Half (b) only: the declared subagent's `tools`. */
  declaredChildTools?: readonly string[];
}

/** Which of the two candidate names `system:init` reported back, if any. */
export function honoredTaskToolName(init: InitObservation): 'Task' | 'Agent' | 'both' | null {
  const task = init.tools.includes('Task');
  const agent = init.tools.includes('Agent');
  if (task && agent) return 'both';
  if (task) return 'Task';
  if (agent) return 'Agent';
  return null;
}

export function classifyP3(i: TaskInputs): ArmVerdict {
  const arm = i.half === 'a' ? 'P3a' : 'P3b';
  if (!i.init) return { arm, conclusive: false, verdict: 'INCONCLUSIVE -- no system:init', stops: [] };
  const honored = honoredTaskToolName(i.init);
  if (honored === null) {
    // A definite measurement: neither name is enabled by the allowlist, so
    // the delegation turn is skipped (there is nothing to delegate with).
    return {
      arm,
      conclusive: true,
      verdict: `TASK NOT ENABLED -- neither 'Task' nor 'Agent' appears in system:init tools after passing both in the allowlist (reported: ${JSON.stringify(i.init.tools.filter((t) => !t.startsWith('mcp__')))})`,
      stops: [`${arm}: the subagent tool cannot be enabled through Options.tools on this build -- D3's picklist literal has no honored name`],
    };
  }
  if (!i.turnSettled) return { arm, conclusive: false, verdict: `INCONCLUSIVE -- honored name ${honored}, but the delegation turn did not settle`, stops: [] };
  const ran = i.subagentStarts.length > 0 || i.childToolCalls.length > 0;
  if (!ran) {
    return {
      arm,
      conclusive: true,
      verdict: `NO SUBAGENT RAN -- honored name ${honored}, turn settled, but no SubagentStart firing and no agent_id-bearing tool call (nonceRelayed=${i.nonceRelayed})`,
      stops: [`${arm}: the model did not (or could not) delegate; re-run before reading anything about containment`],
    };
  }
  const allowed = new Set(i.half === 'b' && i.declaredChildTools ? i.declaredChildTools : i.parentAllowlist);
  const escaped = [...new Set(i.childToolCalls.filter((t) => !allowed.has(t) && !t.startsWith('mcp__')))];
  const claimedBeyond = [...new Set(i.childClaimedTools.filter((t) => !allowed.has(t) && !t.startsWith('mcp__')))];
  const stops: string[] = [];
  if (escaped.length > 0) {
    stops.push(
      `${arm} CONTAINMENT BROKEN -- the subagent USED ${JSON.stringify(escaped)} which the ${i.half === 'b' ? "declared subagent's tools" : "parent's allowlist"} does not include`,
    );
  }
  if (!i.nonceRelayed) stops.push(`${arm}: the child's Read of the nonce file was not relayed by the parent -- the prose observable is missing`);
  return {
    arm,
    conclusive: true,
    verdict: `${escaped.length === 0 ? 'CONTAINED' : 'ESCAPED'} -- honored=${honored} subagentStarts=${JSON.stringify(i.subagentStarts)} childUsed=${JSON.stringify([...new Set(i.childToolCalls)])} childClaimed=${JSON.stringify(i.childClaimedTools)} claimedBeyondAllowlist=${JSON.stringify(claimedBeyond)} nonceRelayed=${i.nonceRelayed}`,
    stops,
  };
}

/** `TOOL: <name>` lines the parent relayed from the child, deduplicated. */
export function parseClaimedTools(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/TOOL:\s*([A-Za-z0-9_]+)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argument parsing -- inside main() only (import-safety guard)
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--p0', '--p1', '--p2', '--p3'] as const;
const CONTINUE_FLAG = '--continue-after-leak';
const USAGE_TEXT =
  `Usage: bun scripts/smoke/probe-sdk-declared-mcp-and-task.ts [--p0] [--p1] [--p2] [--p3] [${CONTINUE_FLAG}]\n` +
  '  Default (no arm flag) = all four, in that order. P0 first; a P0 leak halts before P2/P3 unless the continue flag is passed.';

function parseArgs(argv: string[]): { arms: Set<string>; continueAfterLeak: boolean } {
  const arms = new Set<string>();
  let continueAfterLeak = false;
  for (const a of argv) {
    if ((ARM_FLAGS as readonly string[]).includes(a)) {
      arms.add(a);
      continue;
    }
    if (a === CONTINUE_FLAG) {
      continueAfterLeak = true;
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (arms.size === 0) for (const f of ARM_FLAGS) arms.add(f);
  return { arms, continueAfterLeak };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/** Same model the sibling probes use; the measurement is about options, not the model. */
const MODEL = 'claude-sonnet-5';
/** The host's User-scope server, per the AC (`claude mcp get chrome-devtools`). */
const AMBIENT_SERVER = 'chrome-devtools';
const MISSING_SERVER = 'missing-command';
/** A path that exists on no host; the negative control's `command`. */
const MISSING_COMMAND = '/nonexistent/probe-sdk-declared-mcp-missing-command';
const PROBE_TOKEN = 'probe-1726-token';

/**
 * The shipped `claude-sdk` definition's `enabledTools`, read from the builtin
 * itself rather than retyped -- P0 asks what TODAY's battery leaks, and the
 * builtin is the only claude-sdk definition that exists today.
 */
const BASE_TOOLS: readonly string[] = claudeSdkAgent.enabledTools ?? [];
const TASK_CANDIDATES = ['Task', 'Agent'] as const;

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

/** The operator's real user-scope `mcpServers` block, read from `~/.claude.json`. */
function readUserScopeMcpServers(): Record<string, unknown> {
  const file = join(homedir(), '.claude.json');
  if (!existsSync(file)) throw new Error(`host precondition: ${file} does not exist`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
  const servers = parsed.mcpServers ?? {};
  if (!(AMBIENT_SERVER in servers)) {
    throw new Error(`host precondition: no User-scope '${AMBIENT_SERVER}' in ${file} (run \`claude mcp get ${AMBIENT_SERVER}\`)`);
  }
  return servers;
}

/**
 * Seeds the isolated config dir with ONLY the user-scope `mcpServers` block
 * (the P0 proxy described in the header). Returns the seeded server names.
 */
function seedUserScopeServers(configDir: string, servers: Record<string, unknown>): string[] {
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  return Object.keys(servers);
}

/** The stand-in for production's console-served `agent-console` HTTP MCP server. */
async function startAgentConsoleStandIn(): Promise<{ url: string; stop: () => void }> {
  const server = new McpServer({ name: 'agent-console', version: '0.0.0-probe' });
  server.registerTool('probe_ping', { description: 'Probe stand-in; replies pong.' }, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => transport.handleRequest(req) });
  return { url: `http://127.0.0.1:${srv.port}/`, stop: () => srv.stop(true) };
}

/**
 * Records hook firings the arms read: `PreToolUse` (with the subagent
 * attribution fields), `PostToolUse`, and `SubagentStart`. Observation only
 * -- every callback returns `{ continue: true }` and injects nothing.
 */
class HookRecorder {
  readonly preToolUse: Array<{ tool: string; agentId?: string; agentType?: string }> = [];
  readonly postToolUse: Array<{ tool: string; agentId?: string }> = [];
  readonly subagentStarts: string[] = [];
  readonly hooks: Options['hooks'];

  constructor() {
    const observe: HookCallbackMatcher = {
      hooks: [
        async (input): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name === 'PreToolUse') {
            this.preToolUse.push({ tool: String(input.tool_name), agentId: input.agent_id, agentType: input.agent_type });
          } else if (input.hook_event_name === 'PostToolUse') {
            this.postToolUse.push({ tool: String(input.tool_name), agentId: input.agent_id });
          } else if (input.hook_event_name === 'SubagentStart') {
            this.subagentStarts.push(input.agent_type);
          }
          return { continue: true };
        },
      ],
    };
    this.hooks = { PreToolUse: [observe], PostToolUse: [observe], SubagentStart: [observe] };
  }
}

interface BatteryVariation {
  /** `undefined` OMITS the key (the SDK default); `[]` is production. */
  settingSources?: 'omit' | 'production';
  strictMcpConfig?: boolean;
  extraMcpServers?: Record<string, McpServerConfig>;
  extraTools?: readonly string[];
  agents?: Options['agents'];
}

/**
 * Mirrors `sdk-engine.ts`'s `buildOptions()` field for field, with the
 * `agent-console` stand-in URL and this probe's observation hooks in place
 * of production's PostCompact/PostToolUse hooks. Everything a variation does
 * not touch is production's value.
 */
function buildBattery(cwd: string, agentConsoleUrl: string, hooks: Options['hooks'], v: BatteryVariation): Options {
  const options: Options = {
    executable: 'bun',
    cwd,
    model: MODEL,
    tools: [...BASE_TOOLS, SDK_COMPACT_TOOL_NAME, SDK_TODO_WRITE_TOOL_NAME, ...(v.extraTools ?? [])],
    mcpServers: {
      'agent-console': {
        type: 'http',
        url: agentConsoleUrl,
        headers: { Authorization: `Bearer ${PROBE_TOKEN}` },
        alwaysLoad: true,
      },
      console: createSdkMcpServer({
        name: 'console',
        tools: [createSdkCompactTool(() => undefined), createSdkTodoWriteTool()],
      }),
      ...(v.extraMcpServers ?? {}),
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settings: { autoCompactEnabled: false, autoMemoryEnabled: false },
    hooks,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a probe subject. Follow instructions literally.' },
  };
  if ((v.settingSources ?? 'production') === 'production') options.settingSources = [];
  if (v.strictMcpConfig !== undefined) options.strictMcpConfig = v.strictMcpConfig;
  if (v.agents !== undefined) options.agents = v.agents;
  return options;
}

function initObservation(init: SystemInitMessage | null): InitObservation | null {
  return init ? { tools: [...init.tools], mcpServers: init.mcp_servers.map((s) => ({ name: s.name, status: s.status })) } : null;
}

function logInit(label: string, init: SystemInitMessage | null): void {
  if (!init) {
    console.log(`${label}: system:init = (none)`);
    return;
  }
  console.log(`${label}: claude_code_version=${init.claude_code_version} model=${init.model}`);
  console.log(`${label}: mcp_servers = ${JSON.stringify(init.mcp_servers)}`);
  console.log(`${label}: agents = ${JSON.stringify(init.agents ?? null)}`);
  console.log(`${label}: tools (non-mcp) = ${JSON.stringify(init.tools.filter((t) => !t.startsWith('mcp__')))}`);
  console.log(`${label}: tools (mcp) = ${JSON.stringify(init.tools.filter((t) => t.startsWith('mcp__')))}`);
}

async function readPostStatus(s: ProbeSession, label: string): Promise<McpServerStatus[]> {
  try {
    const statuses = await s.q.mcpServerStatus();
    console.log(`${label}: mcpServerStatus() = ${JSON.stringify(statuses.map((x) => ({ name: x.name, status: x.status })))}`);
    return statuses;
  } catch (err) {
    console.log(`${label}: mcpServerStatus() threw: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface SessionRun {
  init: InitObservation | null;
  post: McpServerStatus[];
  outcome: TurnOutcome;
  recorder: HookRecorder;
  session: ProbeSession;
}

/**
 * One session, one turn, then a settled status read. `system:init` does not
 * arrive until a turn is pushed (harness header), so even the arms that only
 * want the init body spend one small turn.
 */
async function runOneSession(
  label: string,
  cwd: string,
  agentConsoleUrl: string,
  variation: BatteryVariation,
  prompt: string,
  turnTimeoutMs = 240_000,
): Promise<SessionRun> {
  const recorder = new HookRecorder();
  const session = new ProbeSession({ label, options: buildBattery(cwd, agentConsoleUrl, recorder.hooks, variation), pollUsage: false });
  const ready = await session.waitForReady();
  console.log(`${label}: ready=${ready}`);
  const outcome = await session.runTurn(prompt, turnTimeoutMs);
  account(label, outcome);
  console.log(turnLine(label, outcome));
  logInit(label, session.systemInit);
  const post = await readPostStatus(session, label);
  session.close();
  await session.waitForStreamEnd();
  return { init: initObservation(session.systemInit), post, outcome, recorder, session };
}

const PONG_PROMPT = 'Reply with exactly the single word: pong';

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

async function armP0(cwd: string, url: string, seeded: string[]): Promise<ArmVerdict> {
  h(`P0 BASELINE -- today's battery vs a seeded user-scope config (${JSON.stringify(seeded)})`);
  const subject = await runOneSession('P0-subject', cwd, url, { settingSources: 'production' }, PONG_PROMPT);
  const control = await runOneSession('P0-control', cwd, url, { settingSources: 'omit' }, PONG_PROMPT);
  const verdict = classifyP0(
    turnSettled(subject.outcome) ? subject.init : null,
    turnSettled(control.outcome) ? control.init : null,
    AMBIENT_SERVER,
  );
  console.log(`P0 verdict: ${verdict.verdict}`);
  return verdict;
}

async function armP1(cwd: string, url: string): Promise<ArmVerdict> {
  h('P1 STRICT -- battery + strictMcpConfig: true');
  const run = await runOneSession('P1', cwd, url, { strictMcpConfig: true }, PONG_PROMPT);
  const verdict = classifyP1(turnSettled(run.outcome) ? run.init : null, run.post);
  console.log(`P1 verdict: ${verdict.verdict}`);
  return verdict;
}

async function armP2(cwd: string, url: string, userServers: Record<string, unknown>): Promise<ArmVerdict> {
  h(`P2 DECLARED -- P1 + declared '${AMBIENT_SERVER}' (host's own config) + '${MISSING_SERVER}' negative control`);
  const declared = userServers[AMBIENT_SERVER] as McpServerConfig;
  console.log(`P2: declared ${AMBIENT_SERVER} = ${JSON.stringify(declared)}`);
  const run = await runOneSession(
    'P2',
    cwd,
    url,
    {
      strictMcpConfig: true,
      extraMcpServers: {
        [AMBIENT_SERVER]: declared,
        [MISSING_SERVER]: { type: 'stdio', command: MISSING_COMMAND },
      },
    },
    `Call the tool named mcp__${AMBIENT_SERVER}__list_pages exactly once with no arguments. Then reply with ONLY the single word DONE. If that tool is not available to you, reply with ONLY the single word UNAVAILABLE and call nothing.`,
  );
  const declaredToolCalls = run.recorder.postToolUse.filter((f) => !f.agentId && mcpServerOf(f.tool) === AMBIENT_SERVER).length;
  console.log(`P2: PostToolUse firings = ${JSON.stringify(run.recorder.postToolUse)}`);
  console.log(`P2: answer = ${JSON.stringify(run.outcome.text.trim().slice(0, 200))}`);
  const verdict = classifyP2({
    init: run.init,
    post: run.post,
    declaredName: AMBIENT_SERVER,
    missingName: MISSING_SERVER,
    declaredToolCalls,
    turnSettled: turnSettled(run.outcome),
  });
  console.log(`P2 verdict: ${verdict.verdict}`);
  return verdict;
}

function writeNonceFile(cwd: string, token: string): string {
  const file = join(cwd, `probe-nonce-${token}.txt`);
  writeFileSync(
    file,
    [
      `NONCE=${token}`,
      'Instructions for the agent reading this file:',
      '1. List EVERY tool you currently have available, one per line, each line formatted exactly as: TOOL: <name>',
      '2. If you have a tool named Bash, run exactly this command with it: echo PROBE_BASH_OK',
      `3. End your reply with the line: NONCE=${token}`,
    ].join('\n'),
  );
  return file;
}

async function armP3(cwd: string, url: string, half: 'a' | 'b'): Promise<ArmVerdict> {
  const label = half === 'a' ? 'P3a' : 'P3b';
  h(`${label} TASK -- P1 + tools+${JSON.stringify(TASK_CANDIDATES)}${half === 'b' ? " + agents: { probe: { tools: ['Read'] } }" : ' (no agents)'}`);
  const token = nonce('P3');
  const file = writeNonceFile(cwd, token);
  const declaredChildTools = ['Read'] as const;
  const agents: Options['agents'] | undefined =
    half === 'b'
      ? {
          probe: {
            description: 'Probe subagent: reads one file and reports its tool list.',
            prompt: 'You are a probe subagent. Do exactly what the file you are asked to read says, and report verbatim.',
            tools: [...declaredChildTools],
          },
        }
      : undefined;
  const subagentType = half === 'b' ? 'probe' : 'general-purpose';
  const prompt =
    `Delegate the following to a subagent using your Task tool (or Agent tool, whichever you have), with subagent_type "${subagentType}", run_in_background false: ` +
    `"Read the file ${file} with your Read tool and follow the instructions inside it exactly." ` +
    'When the subagent finishes, reply with the subagent\'s full report VERBATIM and nothing else. Do not read the file yourself.';
  const run = await runOneSession(label, cwd, url, { strictMcpConfig: true, extraTools: TASK_CANDIDATES, agents }, prompt, 300_000);
  const childToolCalls = run.recorder.preToolUse.filter((f) => f.agentId !== undefined).map((f) => f.tool);
  const parentToolCalls = run.recorder.preToolUse.filter((f) => f.agentId === undefined).map((f) => f.tool);
  console.log(`${label}: SubagentStart firings = ${JSON.stringify(run.recorder.subagentStarts)}`);
  console.log(`${label}: PreToolUse (parent) = ${JSON.stringify(parentToolCalls)}`);
  console.log(`${label}: PreToolUse (child, by agent_id) = ${JSON.stringify(run.recorder.preToolUse.filter((f) => f.agentId !== undefined))}`);
  console.log(`${label}: stream tool_use blocks = ${JSON.stringify(run.session.toolUses.map((t) => ({ name: t.name, parent: t.parentToolUseId })))}`);
  console.log(`${label}: answer = ${JSON.stringify(run.outcome.text.trim().slice(0, 600))}`);
  const verdict = classifyP3({
    half,
    init: run.init,
    parentAllowlist: [...BASE_TOOLS, ...TASK_CANDIDATES],
    subagentStarts: run.recorder.subagentStarts,
    childToolCalls,
    nonceRelayed: run.outcome.text.includes(`NONCE=${token}`),
    childClaimedTools: parseClaimedTools(run.outcome.text),
    turnSettled: turnSettled(run.outcome),
    declaredChildTools: half === 'b' ? declaredChildTools : undefined,
  });
  console.log(`${label} verdict: ${verdict.verdict}`);
  return verdict;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { arms, continueAfterLeak } = parseArgs(process.argv.slice(2));
  const userServers = readUserScopeMcpServers();
  const configDir = isolateClaudeConfigDir('declared-mcp');
  const seeded = seedUserScopeServers(configDir, userServers);
  const cwd = mkdtempSync(join(tmpdir(), 'probe-sdk-declared-mcp-cwd-'));
  const standIn = await startAgentConsoleStandIn();
  h(`probe-sdk-declared-mcp-and-task -- arms=${[...arms].join(' ')} config=${configDir} cwd=${cwd} agent-console stand-in=${standIn.url}`);
  console.log(`seeded user-scope mcpServers into the isolated config: ${JSON.stringify(seeded)}`);
  console.log(`base tools (claude-sdk builtin enabledTools): ${JSON.stringify(BASE_TOOLS)}`);

  const verdicts: ArmVerdict[] = [];
  let halted: string | null = null;
  try {
    if (arms.has('--p0')) {
      const v = await armP0(cwd, standIn.url, seeded);
      verdicts.push(v);
      if (v.stops.length > 0 && !continueAfterLeak && (arms.has('--p2') || arms.has('--p3'))) {
        halted = `P0 observed a leak; P2/P3 are withheld until it is reported (pass ${CONTINUE_FLAG} to override)`;
      }
    }
    if (arms.has('--p1')) verdicts.push(await armP1(cwd, standIn.url));
    if (!halted && arms.has('--p2')) verdicts.push(await armP2(cwd, standIn.url, userServers));
    if (!halted && arms.has('--p3')) {
      verdicts.push(await armP3(cwd, standIn.url, 'a'));
      verdicts.push(await armP3(cwd, standIn.url, 'b'));
    }
  } finally {
    standIn.stop();
  }

  h('ISOLATION');
  const iso = verifyIsolation(configDir);
  console.log(`config dir ${configDir}: evidence=${JSON.stringify(iso.evidence)} transcripts=${iso.files.length}`);
  if (!iso.ok) {
    console.log('HARNESS: the CLAUDE_CONFIG_DIR override did not reach the child; every isolation claim above is void');
    return PROBE_EXIT.HARNESS;
  }

  h('VERDICTS');
  for (const v of verdicts) {
    console.log(`${v.arm}: ${v.verdict}`);
    for (const s of v.stops) console.log(`STOP: ${s}`);
  }
  if (halted) console.log(`HALTED: ${halted}`);
  const t = totals();
  console.log(`\nturns=${perTurn.size} promptTokens=${t.tokens} cost=$${t.cost.toFixed(4)} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
  const code = exitCodeFor(verdicts);
  console.log(`exit ${code}: ${EXIT_CODE_MEANINGS[code]}`);
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // Scratch cwd; leaving it behind is harmless.
  }
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
