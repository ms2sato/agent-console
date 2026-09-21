#!/usr/bin/env bun
/**
 * Task 0 premise probe for epic #1636 Phase 5 PR-2 (Issue #1785): the
 * `claude-sdk` engine's own MCP-server discovery/permission machinery, per
 * `docs/design/embedded-agent-sdk-engine.md` §4.5's design II. Measurement
 * only -- this script changes no production behavior and is not wired into
 * CI, the same class of tool as its siblings `probe-sdk-declared-mcp-and-task.ts`
 * and `probe-sdk-mcp-settings-sources.ts`.
 *
 * WHY THIS PROBE, and how it differs from its two MCP-probing siblings. Both
 * siblings measure what a STATIC `Options` battery does at session
 * construction time (declared servers, `strictMcpConfig`, `settingSources`
 * scoping). Design II's PR-2 needs two things neither sibling measured: (a)
 * whether a server can be added to an ALREADY-RUNNING session -- the
 * discovery-then-approve flow requires adding a server the user just
 * approved without restarting the worker -- and (b) whether a subagent can
 * be declared and constrained PROGRAMMATICALLY via `Options.agents`, as
 * opposed to a `.claude/agents/*.md` file the SDK might or might not load
 * natively under a given `settingSources`. Both are premises this repo has
 * never measured; nothing in `sdk.d.ts` documents either behavior beyond the
 * bare method/field signature.
 *
 * THE BATTERY, common to both arms, mirrors design II's specified shape --
 * NOT the two sibling probes' battery, which use `settingSources: []` or
 * `['user','project']`:
 *
 *   - `settingSources: ['user', 'local']` (never `[]`, never with `'project'`)
 *   - NO `strictMcpConfig`
 *   - `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`
 *   - `mcpServers` starting with ONLY the reserved pair: `agent-console` (the
 *     `startAgentConsoleStandIn()` HTTP stand-in, reused verbatim from the
 *     declared-mcp-and-task probe) and an in-process `console` server with
 *     one trivial no-op tool (this probe does not need production's real
 *     Compact/TodoWrite tools -- only that an in-process SDK server survives
 *     the session's whole life, including a later `setMcpServers` re-pass)
 *   - a scratch `cwd` (no `.mcp.json`; `['user','local']` does not read
 *     project-scoped MCP config, so P-a's explicit-door-only shape needs
 *     nothing project-scoped declared)
 *
 * P-a: LIVE ADD VIA `Query.setMcpServers`. One session, one baseline turn,
 * then a live `setMcpServers` call that re-passes the FULL reserved pair
 * (the SDK doc: this call REPLACES the current dynamically-added set) plus
 * a new stdio server (`probe-live-add`, the shared `stdio-echo-mcp-server.ts`
 * fixture) and a NEGATIVE CONTROL server whose command does not exist
 * (`probe-missing-command`). PASS conditions for the positive half: the
 * fixture's own spawn canary exists (the OS process was actually exec'd,
 * independent of whatever `mcpServerStatus()` reports), `mcpServerStatus()`
 * reports the new server `connected`, and a real `probe_echo` call was
 * observed via `PostToolUse`. PASS conditions for the negative control: the
 * missing-command server shows up in `McpSetServersResult.errors` or as
 * `failed` in `mcpServerStatus()`, no tool from it ever appears, and the
 * SAME turn that drove the positive half still settled normally -- a second
 * server's failure must not brick the turn. Two further readings are
 * RECORDED (not gated): (i) whether the reserved pair's own status, read
 * immediately before and after the `setMcpServers` call, confirms the
 * "replaces the full dynamic set" semantics actually require resending
 * everything (i.e. did re-passing `agent-console`/`console` keep them
 * connected, as opposed to a lenient "unlisted servers survive" reading);
 * (ii) whether re-passing the SAME in-process `console`
 * `createSdkMcpServer()` object instance through a second `setMcpServers`
 * call produces a duplicate-registration error or is accepted cleanly. This
 * probe always tries the SAME instance (never a fresh one with the same
 * name) -- noted here and at the print site so a reader knows which variant
 * was measured.
 *
 * RECORD(1) above is binding on the engine implementation, not merely
 * descriptive: `docs/design/embedded-agent-sdk-engine.md`'s §4.5 already
 * specifies `setMcpServers({ ...reservedPair, ...servers })` (always the
 * full set); this probe measured that re-passing the reserved pair keeps it
 * connected, but never measured what happens if the reserved pair is
 * OMITTED from a `setMcpServers` call -- that case must not be assumed safe,
 * and the engine's own live-add path (PR-2) must always include the
 * reserved pair, which its own test suite should pin directly rather than
 * relying on this probe's finding alone.
 *
 * P-b: AGENTS THROUGH `Options.agents`. A scratch git repo carries a
 * `.claude/agents/probe-agent.md` file (frontmatter `name: probe-agent`,
 * a nonce `description`, `tools: Read`; body prompt says "You are the FILE
 * VERSION"). SUBJECT: the same battery + `Options.agents = { 'probe-agent':
 * { ... } }` whose prompt says "You are the OPTION VERSION" and carries its
 * OWN nonce, plus `'Task'` added to the parent's tool allowlist (needed for
 * delegation only in this arm). One turn delegates to `subagent_type:
 * 'probe-agent'` and asks it to report its nonce and version. PASS
 * conditions: `system:init.agents` names `probe-agent` EXACTLY ONCE (not
 * twice -- the file version must not ALSO be natively loaded alongside the
 * option version), a `SubagentStart` firing for `probe-agent` is observed,
 * and the relayed answer carries the OPTION nonce and says OPTION rather
 * than FILE. CONTROL: identical repo and battery, `Options.agents` OMITTED,
 * same delegation-shaped prompt (expected to fail gracefully -- that is
 * fine). PASS condition: `system:init.agents` does NOT name `probe-agent` at
 * all -- re-pins PS10 (the file alone, with `'project'` outside
 * `settingSources`, is not natively loaded) for this specific battery. A
 * SUBJECT failure is a STOP finding per the design AC ("STOP and report to
 * the Orchestrator") -- printed prominently, still exit 0 (a STOP is a
 * definite reading, not an inconclusive one; only a turn that never settles
 * is inconclusive).
 *
 * VERDICTS AND EXIT CODES (`PROBE_EXIT`), same convention as both siblings:
 * 0 = every selected arm produced a definite measurement (a STOP finding IS
 * a measurement); 1 = INCONCLUSIVE for at least one selected arm (a control
 * failed, a turn did not settle); 2 = HARNESS (bad arguments, unverified
 * isolation, an exception escaping `main`).
 *
 * DEVIATION FROM THE ORIGINAL TASK WORDING, recorded here rather than only
 * in the delivery report: the task described calling `verifyIsolation()`
 * "before running any arm". `verifyIsolation()`'s own contract (see
 * `probe-sdk-session-harness.ts`) is proof that the isolated
 * `CLAUDE_CONFIG_DIR` override reached a CHILD PROCESS -- it reads for
 * `.claude.json` / `projects` / `sessions` under the isolated dir, none of
 * which exist until at least one `claude` child has actually run. Calling
 * it before any arm would therefore read `ok: false` on every single
 * invocation, regardless of whether isolation actually works, which is the
 * opposite of what the check is for. This script instead isolates the
 * config dir up front (so every arm inherits the override from the start)
 * and calls `verifyIsolation()` once after all selected arms have run and
 * before printing verdicts -- exactly the sequencing both sibling probes
 * use, and the only sequencing under which the check can produce a true
 * negative.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user; `bun install` already run; `git` on PATH (P-b's scratch repo).
 * BILLABLE -- roughly 4 small turns (P-a: baseline + tool-call; P-b: subject
 * + control). A manual gate, never a CI job; registered in
 * `.claude/rules/test-trigger.md`.
 *
 * 2026-09-21 run note. The first real run of this probe (2026-09-21, exit 0,
 * P-a: LIVE ADD WORKS, P-b: OPTIONS.AGENTS WORKS, no STOP) had its stdout log
 * truncated at 29 lines by a since-fixed bug in this file's own entry point:
 * `process.exit()` was called immediately on `main()`'s resolution, which
 * could terminate the process before the buffered log lines for the VERDICTS
 * section and the final cost/token totals had flushed to the redirected
 * file. The verdicts above were recovered by reading the raw session
 * transcripts directly from the isolated `CLAUDE_CONFIG_DIR` rather than from
 * the truncated log. The entry point now sets `process.exitCode` instead of
 * calling `process.exit()`, which lets the process exit naturally once
 * stdout has drained.
 *
 * Usage: bun scripts/smoke/probe-sdk-phase5-pr2-premises.ts [--p-a] [--p-b]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createSdkMcpServer,
  tool,
  type HookCallbackMatcher,
  type McpServerConfig,
  type Options,
  type SyncHookJSONOutput,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { claudeSdkAgent } from '../../packages/server/src/services/embedded-agents/claude-sdk-builtin.ts';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  turnSettled,
  verifyIsolation,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';
import { RESERVED_MCP_SERVER_NAMES, startAgentConsoleStandIn } from './probe-sdk-declared-mcp-and-task.js';
import { mcpServerOf } from '../../packages/embedded-agent/src/mcp-names.js';

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
  arm: 'Pa' | 'Pb-subject' | 'Pb-control';
  conclusive: boolean;
  verdict: string;
  /** Findings that change a design or need their own report; printed as `STOP:` lines. */
  stops: string[];
}

/**
 * Same simple mapping both MCP sibling probes use: a STOP finding is a
 * measurement (conclusive=true), so only an unread arm downgrades the exit
 * code. The empty set is INCONCLUSIVE -- exit 0 would claim a measurement
 * nobody made.
 */
export function exitCodeFor(verdicts: ReadonlyArray<Pick<ArmVerdict, 'conclusive'>>): number {
  if (verdicts.length === 0) return PROBE_EXIT.INCONCLUSIVE;
  return verdicts.every((v) => v.conclusive) ? PROBE_EXIT.MEASURED : PROBE_EXIT.INCONCLUSIVE;
}

// ---------------------------------------------------------------------------
// P-a: live add via Query.setMcpServers
// ---------------------------------------------------------------------------

export interface PaInputs {
  turnSettled: boolean;
  canaryExists: boolean;
  toolCallObserved: boolean;
  missingToolCallObserved: boolean;
  statusByName: ReadonlyArray<{ name: string; status: string }>;
  setResult: { added: string[]; removed: string[]; errors: Record<string, string> };
  newServerName: string;
  missingServerName: string;
}

/**
 * P-a's verdict. `turnSettled` gates everything else: a turn that never
 * settled measured nothing, so its shape (empty text, no observed hook
 * firings) must never be read as "the tool call did not happen".
 */
export function classifyPa(i: PaInputs): ArmVerdict {
  if (!i.turnSettled) {
    return { arm: 'Pa', conclusive: false, verdict: 'INCONCLUSIVE -- the tool-call turn did not settle', stops: [] };
  }
  const connected = i.statusByName.some((s) => s.name === i.newServerName && s.status === 'connected');
  const positiveOk = i.canaryExists && connected && i.toolCallObserved;
  const missingFailed =
    i.missingServerName in i.setResult.errors ||
    i.statusByName.some((s) => s.name === i.missingServerName && s.status === 'failed');
  const negativeOk = missingFailed && !i.missingToolCallObserved;
  const stops: string[] = [];
  if (!positiveOk) {
    stops.push(
      `Pa positive: '${i.newServerName}' canaryExists=${i.canaryExists} connected=${connected} toolCallObserved=${i.toolCallObserved} -- live add via setMcpServers did not fully work`,
    );
  }
  if (!negativeOk) {
    stops.push(
      `Pa negative control: '${i.missingServerName}' did not read as a clean, declared failure (failed=${missingFailed}, toolCallObserved=${i.missingToolCallObserved})`,
    );
  }
  return {
    arm: 'Pa',
    conclusive: true,
    verdict: `${positiveOk && negativeOk ? 'LIVE ADD WORKS' : 'LIVE ADD DEVIATES'} -- ${i.newServerName}: canary=${i.canaryExists} connected=${connected} toolCall=${i.toolCallObserved}; ${i.missingServerName}: failed=${missingFailed} toolCall=${i.missingToolCallObserved}`,
    stops,
  };
}

/**
 * RECORD-only reading (not gated): does re-passing the reserved pair through
 * `setMcpServers` keep them connected? Pure so the empty-list boundary
 * ("(absent)" for every name) is pinned without a billed run.
 */
export function describeReservedPersistence(
  before: ReadonlyArray<{ name: string; status: string }>,
  after: ReadonlyArray<{ name: string; status: string }>,
  reserved: readonly string[],
): string {
  const statusOf = (list: ReadonlyArray<{ name: string; status: string }>, n: string): string =>
    list.find((s) => s.name === n)?.status ?? '(absent)';
  return reserved.map((n) => `${n}: before=${statusOf(before, n)} after=${statusOf(after, n)}`).join('; ');
}

/**
 * RECORD-only reading (not gated): re-passing the SAME in-process `console`
 * instance through a second `setMcpServers` call -- does the SDK report a
 * duplicate-registration error for it, or accept the re-pass cleanly?
 * Boundary cases: an empty `errors` object (nothing to report) and an
 * `errors` object naming the server under test both classify deterministically.
 */
export function classifyDuplicateConsoleRegistration(
  setResult: { errors: Record<string, string> },
  consoleName: string,
): 'accepted-cleanly' | 'errored' {
  return consoleName in setResult.errors ? 'errored' : 'accepted-cleanly';
}

// ---------------------------------------------------------------------------
// P-b: agents through Options.agents
// ---------------------------------------------------------------------------

/** How many times `name` appears in `system:init`'s `agents` list. `undefined` counts as zero. */
export function agentEntryCount(agents: readonly string[] | undefined, name: string): number {
  if (!agents) return 0;
  return agents.filter((a) => a === name).length;
}

export interface AgentsExactlyOneReading {
  count: number;
  exactlyOne: boolean;
}

/**
 * Whether `name` appears in `system:init.agents` EXACTLY once. A count of
 * two (declared via `Options.agents` AND natively loaded from the file) is
 * its own finding, never silently accepted as "present".
 */
export function classifyAgentsExactlyOne(agents: readonly string[] | undefined, name: string): AgentsExactlyOneReading {
  const count = agentEntryCount(agents, name);
  return { count, exactlyOne: count === 1 };
}

export interface PbSubjectInputs {
  turnSettled: boolean;
  agentsInInit: readonly string[] | undefined;
  subagentStartFired: boolean;
  answer: string;
  optionNonce: string;
}

export function classifyPbSubject(i: PbSubjectInputs): ArmVerdict {
  if (!i.turnSettled) {
    return { arm: 'Pb-subject', conclusive: false, verdict: 'INCONCLUSIVE -- the delegation turn did not settle', stops: [] };
  }
  const agentsReading = classifyAgentsExactlyOne(i.agentsInInit, 'probe-agent');
  const nonceRelayed = i.answer.includes(i.optionNonce);
  const saysOption = /\bOPTION\b/.test(i.answer);
  const saysFile = /\bFILE\b/.test(i.answer);
  const ok = agentsReading.exactlyOne && i.subagentStartFired && nonceRelayed && saysOption && !saysFile;
  const stops: string[] = [];
  if (!agentsReading.exactlyOne) {
    stops.push(
      `Pb-subject: system:init.agents reported 'probe-agent' ${agentsReading.count} time(s), not exactly once (agents=${JSON.stringify(i.agentsInInit ?? null)})`,
    );
  }
  if (!i.subagentStartFired) stops.push('Pb-subject: no SubagentStart firing observed for probe-agent');
  if (!nonceRelayed) stops.push('Pb-subject: the OPTION nonce was not relayed by the parent');
  if (!saysOption || saysFile) {
    stops.push(
      `Pb-subject: the answer did not clearly report the OPTION version (saysOption=${saysOption} saysFile=${saysFile}) -- Options.agents may not be taking precedence over the file`,
    );
  }
  return {
    arm: 'Pb-subject',
    conclusive: true,
    verdict: `${ok ? 'OPTIONS.AGENTS WORKS' : 'OPTIONS.AGENTS DEVIATES'} -- agentsCount=${agentsReading.count} subagentStart=${i.subagentStartFired} nonceRelayed=${nonceRelayed} saysOption=${saysOption} saysFile=${saysFile}`,
    stops,
  };
}

export interface PbControlInputs {
  turnSettled: boolean;
  agentsInInit: readonly string[] | undefined;
}

export function classifyPbControl(i: PbControlInputs): ArmVerdict {
  if (!i.turnSettled) {
    return { arm: 'Pb-control', conclusive: false, verdict: 'INCONCLUSIVE -- the control turn did not settle', stops: [] };
  }
  const count = agentEntryCount(i.agentsInInit, 'probe-agent');
  const ok = count === 0;
  return {
    arm: 'Pb-control',
    conclusive: true,
    verdict: `${ok ? 'CONTROL CLEAN' : 'CONTROL LEAKED'} -- system:init.agents reported 'probe-agent' ${count} time(s) with Options.agents omitted (re-pins PS10 for this battery)`,
    stops: ok
      ? []
      : [
          `Pb-control: 'probe-agent' appeared in system:init.agents (${count}x) even though Options.agents was omitted and 'project' is not in settingSources -- the file alone is being natively loaded`,
        ],
  };
}

// ---------------------------------------------------------------------------
// Argument parsing -- inside main() only (import-safety guard)
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--p-a', '--p-b'] as const;
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-phase5-pr2-premises.ts [--p-a] [--p-b]\n' +
  '  Default (no arm flag) = both, in order (P-a first, then P-b).';

function parseArgs(argv: string[]): Set<string> {
  const arms = new Set<string>();
  for (const a of argv) {
    if ((ARM_FLAGS as readonly string[]).includes(a)) {
      arms.add(a);
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (arms.size === 0) for (const f of ARM_FLAGS) arms.add(f);
  return arms;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/** Same model the sibling probes use; the measurement is about the SDK's own machinery, not the model. */
const MODEL = 'claude-sonnet-5';
const FIXTURE_PATH = resolve(import.meta.dir, 'fixtures/stdio-echo-mcp-server.ts');
const PROBE_TOKEN = 'probe-1785-token';
const NEW_SERVER_NAME = 'probe-live-add';
const MISSING_SERVER_NAME = 'probe-missing-command';
const MISSING_COMMAND = '/nonexistent/probe-sdk-phase5-pr2-missing-command';

/**
 * The shipped `claude-sdk` definition's `enabledTools`, read from the builtin
 * itself rather than retyped, same rationale as the declared-mcp-and-task
 * probe: this is TODAY's real allowlist, not a hand-picked one.
 */
const BASE_TOOLS: readonly string[] = claudeSdkAgent.enabledTools ?? [];

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

function buildAgentConsoleConfig(url: string): McpServerConfig {
  return { type: 'http', url, headers: { Authorization: `Bearer ${PROBE_TOKEN}` }, alwaysLoad: true };
}

/** A fresh in-process `console` stand-in: one trivial no-op tool, nothing production-shaped needed for this probe. */
function buildConsoleServer(): McpServerConfig {
  return createSdkMcpServer({
    name: 'console',
    tools: [
      tool('probe_noop', 'Probe stand-in no-op tool for the console MCP server. Not for real use.', {}, async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      })),
    ],
  });
}

interface BatteryVariation {
  extraTools?: readonly string[];
  agents?: Options['agents'];
}

/**
 * Design II's battery (this file's header): `settingSources: ['user',
 * 'local']`, no `strictMcpConfig`, `bypassPermissions`, the reserved pair
 * only. `consoleConfig` is threaded in by the caller (rather than built
 * here) so P-a can hold the SAME instance across the initial construction
 * and its later `setMcpServers` re-passes.
 */
function buildBattery(
  cwd: string,
  agentConsoleUrl: string,
  consoleConfig: McpServerConfig,
  hooks: Options['hooks'],
  v: BatteryVariation = {},
): Options {
  const options: Options = {
    executable: 'bun',
    cwd,
    model: MODEL,
    tools: [...BASE_TOOLS, ...(v.extraTools ?? [])],
    mcpServers: {
      'agent-console': buildAgentConsoleConfig(agentConsoleUrl),
      console: consoleConfig,
    },
    settingSources: ['user', 'local'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    hooks,
  };
  if (v.agents !== undefined) options.agents = v.agents;
  return options;
}

/**
 * Records hook firings the arms read: `PreToolUse` (subagent attribution
 * fields), `PostToolUse` (which server/tool a call reached), and
 * `SubagentStart`. Observation only -- every callback returns `{ continue:
 * true }` and injects nothing. Pattern copied from the declared-mcp-and-task
 * probe's own (unexported) `HookRecorder`.
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

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

async function armPa(cwd: string, agentConsoleUrl: string): Promise<ArmVerdict> {
  h('P-a LIVE ADD via Query.setMcpServers');
  const recorder = new HookRecorder();
  const consoleConfig = buildConsoleServer();
  const session = new ProbeSession({ label: 'Pa', options: buildBattery(cwd, agentConsoleUrl, consoleConfig, recorder.hooks), pollUsage: false });
  // Idempotent release: the happy path below calls `release()` once, at the
  // point the ORIGINAL code called `session.close(); await
  // session.waitForStreamEnd();` directly. The `finally` also calls it, so
  // an exception thrown from ANY awaited call in between (a `runTurn`, a
  // `mcpServerStatus()` read, etc. -- not just the guarded `setMcpServers`
  // call) still releases the session/child process instead of leaking it.
  let closed = false;
  const release = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    session.close();
    await session.waitForStreamEnd();
  };

  try {
    const ready = await session.waitForReady();
    console.log(`Pa: ready=${ready}`);

    const first = await session.runTurn('Reply with exactly the single word: READY');
    account('Pa-turn1', first);
    console.log(turnLine('Pa-turn1', first));

    const statusBefore = await session.q.mcpServerStatus();
    console.log(`Pa: mcpServerStatus() before setMcpServers = ${JSON.stringify(statusBefore.map((s) => ({ name: s.name, status: s.status })))}`);

    const fixtureDir = mkdtempSync(join(tmpdir(), 'probe-sdk-pr2-pa-fixture-'));
    const canaryPath = join(fixtureDir, `${NEW_SERVER_NAME}.touched`);
    const ledgerPath = join(fixtureDir, 'ledger.tsv');
    // Defensive per the task spec ("delete any stale canary"); fixtureDir is
    // freshly created above so this never actually fires, but a probe reused
    // against a non-fresh dir should not read a leftover canary as evidence.
    if (existsSync(canaryPath)) rmSync(canaryPath);

    let setResult: { added: string[]; removed: string[]; errors: Record<string, string> };
    try {
      setResult = await session.q.setMcpServers({
        'agent-console': buildAgentConsoleConfig(agentConsoleUrl),
        console: consoleConfig,
        [NEW_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [FIXTURE_PATH, '--canary', canaryPath, '--ledger', ledgerPath] },
        [MISSING_SERVER_NAME]: { type: 'stdio', command: MISSING_COMMAND },
      });
    } catch (err) {
      console.log(`Pa: setMcpServers threw: ${err instanceof Error ? err.message : String(err)}`);
      await release();
      return { arm: 'Pa', conclusive: false, verdict: 'INCONCLUSIVE -- setMcpServers threw before any reading could be taken', stops: [] };
    }
    console.log(`Pa: setMcpServers result = ${JSON.stringify(setResult)}`);

    const statusAfterSet = await session.q.mcpServerStatus();
    console.log(`Pa: mcpServerStatus() after setMcpServers = ${JSON.stringify(statusAfterSet.map((s) => ({ name: s.name, status: s.status })))}`);
    console.log(`Pa RECORD reserved-persistence: ${describeReservedPersistence(statusBefore, statusAfterSet, RESERVED_MCP_SERVER_NAMES)}`);

    const second = await session.runTurn(
      `Call the mcp__${NEW_SERVER_NAME}__probe_echo tool exactly once with no arguments and report what it returns. Then reply with ONLY the single word DONE. If that tool is not available to you, reply with ONLY the single word UNAVAILABLE and call nothing.`,
    );
    account('Pa-turn2', second);
    console.log(turnLine('Pa-turn2', second));
    console.log(`Pa: PostToolUse firings = ${JSON.stringify(recorder.postToolUse)}`);
    console.log(`Pa: answer = ${JSON.stringify(second.text.trim().slice(0, 200))}`);

    const canaryExists = existsSync(canaryPath);
    const toolCallObserved = recorder.postToolUse.some((f) => !f.agentId && mcpServerOf(f.tool) === NEW_SERVER_NAME);
    const missingToolCallObserved = recorder.postToolUse.some((f) => mcpServerOf(f.tool) === MISSING_SERVER_NAME);

    const statusAfterTurn = await session.q.mcpServerStatus();

    // RECORD-only: re-pass the SAME `console` instance a second time. This
    // probe always tries the SAME instance, never a fresh one with the same
    // name -- see this file's header for why that variant was chosen.
    try {
      const dupResult = await session.q.setMcpServers({
        'agent-console': buildAgentConsoleConfig(agentConsoleUrl),
        console: consoleConfig,
        [NEW_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [FIXTURE_PATH, '--canary', canaryPath, '--ledger', ledgerPath] },
      });
      console.log(
        `Pa RECORD duplicate-console-registration (SAME instance re-passed) = ${classifyDuplicateConsoleRegistration(dupResult, 'console')} raw=${JSON.stringify(dupResult)}`,
      );
    } catch (err) {
      console.log(`Pa RECORD duplicate-console-registration: the re-pass call threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    await release();

    const verdict = classifyPa({
      turnSettled: turnSettled(second),
      canaryExists,
      toolCallObserved,
      missingToolCallObserved,
      statusByName: statusAfterTurn.map((s) => ({ name: s.name, status: s.status })),
      setResult,
      newServerName: NEW_SERVER_NAME,
      missingServerName: MISSING_SERVER_NAME,
    });
    console.log(`Pa verdict: ${verdict.verdict}`);
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Scratch dir; leaving it behind is harmless.
    }
    return verdict;
  } finally {
    await release();
  }
}

async function armPb(agentConsoleUrl: string): Promise<ArmVerdict[]> {
  h('P-b AGENTS via Options.agents');
  const repoDir = mkdtempSync(join(tmpdir(), 'probe-sdk-pr2-pb-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
  const agentsDir = join(repoDir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const fileDescNonce = nonce('PB-FILE-DESC');
  writeFileSync(
    join(agentsDir, 'probe-agent.md'),
    ['---', 'name: probe-agent', `description: ${fileDescNonce}`, 'tools: Read', '---', 'You are the FILE VERSION. If asked your identity, say FILE.', ''].join(
      '\n',
    ),
  );

  const delegationPrompt =
    'Use the Task tool with subagent_type: "probe-agent" to ask it to report its NONCE and whether it is the FILE or OPTION version. ' +
    "When it finishes, reply with the subagent's answer verbatim and nothing else.";

  // SUBJECT
  const optionNonce = nonce('PB-OPTION');
  const subjectRecorder = new HookRecorder();
  const subjectConsole = buildConsoleServer();
  const subjectSession = new ProbeSession({
    label: 'Pb-subject',
    options: buildBattery(repoDir, agentConsoleUrl, subjectConsole, subjectRecorder.hooks, {
      extraTools: ['Task'],
      agents: {
        'probe-agent': {
          description: `PB-OPTION-DESC-${optionNonce}`,
          prompt: `You are the OPTION VERSION. If asked your identity, say OPTION. NONCE=${optionNonce}`,
          tools: ['Read'],
        },
      },
    }),
    pollUsage: false,
  });
  // Idempotent release, same pattern/rationale as `armPa`'s: any awaited
  // call between construction and the happy-path close (waitForReady,
  // runTurn) can throw, and without a `finally` the session/child process
  // would leak.
  let subjectClosed = false;
  const releaseSubject = async (): Promise<void> => {
    if (subjectClosed) return;
    subjectClosed = true;
    subjectSession.close();
    await subjectSession.waitForStreamEnd();
  };

  let subjectVerdict: ArmVerdict;
  try {
    await subjectSession.waitForReady();
    const subjectOutcome = await subjectSession.runTurn(delegationPrompt, 240_000);
    account('Pb-subject', subjectOutcome);
    console.log(turnLine('Pb-subject', subjectOutcome));
    console.log(`Pb-subject: system:init.agents = ${JSON.stringify(subjectSession.systemInit?.agents ?? null)}`);
    console.log(`Pb-subject: SubagentStart firings = ${JSON.stringify(subjectRecorder.subagentStarts)}`);
    console.log(`Pb-subject: answer = ${JSON.stringify(subjectOutcome.text.trim().slice(0, 400))}`);
    await releaseSubject();

    subjectVerdict = classifyPbSubject({
      turnSettled: turnSettled(subjectOutcome),
      agentsInInit: subjectSession.systemInit?.agents,
      subagentStartFired: subjectRecorder.subagentStarts.includes('probe-agent'),
      answer: subjectOutcome.text,
      optionNonce,
    });
    console.log(`Pb-subject verdict: ${subjectVerdict.verdict}`);
  } finally {
    await releaseSubject();
  }

  // CONTROL -- same repo, same battery, Options.agents omitted entirely.
  const controlConsole = buildConsoleServer();
  const controlSession = new ProbeSession({
    label: 'Pb-control',
    options: buildBattery(repoDir, agentConsoleUrl, controlConsole, {}, { extraTools: ['Task'] }),
    pollUsage: false,
  });
  let controlClosed = false;
  const releaseControl = async (): Promise<void> => {
    if (controlClosed) return;
    controlClosed = true;
    controlSession.close();
    await controlSession.waitForStreamEnd();
  };

  let controlVerdict: ArmVerdict;
  try {
    await controlSession.waitForReady();
    const controlOutcome = await controlSession.runTurn(delegationPrompt, 240_000);
    account('Pb-control', controlOutcome);
    console.log(turnLine('Pb-control', controlOutcome));
    console.log(`Pb-control: system:init.agents = ${JSON.stringify(controlSession.systemInit?.agents ?? null)}`);
    console.log(`Pb-control: answer = ${JSON.stringify(controlOutcome.text.trim().slice(0, 400))}`);
    await releaseControl();

    controlVerdict = classifyPbControl({
      turnSettled: turnSettled(controlOutcome),
      agentsInInit: controlSession.systemInit?.agents,
    });
    console.log(`Pb-control verdict: ${controlVerdict.verdict}`);
  } finally {
    await releaseControl();
  }

  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    // Scratch repo; leaving it behind is harmless.
  }

  return [subjectVerdict, controlVerdict];
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const arms = parseArgs(process.argv.slice(2));
  const configDir = isolateClaudeConfigDir('phase5-pr2-premises');
  const cwdPa = mkdtempSync(join(tmpdir(), 'probe-sdk-pr2-pa-cwd-'));
  const standIn = await startAgentConsoleStandIn();
  h(`probe-sdk-phase5-pr2-premises -- arms=${[...arms].join(' ')} config=${configDir} agent-console stand-in=${standIn.url}`);
  console.log(`base tools (claude-sdk builtin enabledTools): ${JSON.stringify(BASE_TOOLS)}`);

  const verdicts: ArmVerdict[] = [];
  try {
    if (arms.has('--p-a')) verdicts.push(await armPa(cwdPa, standIn.url));
    if (arms.has('--p-b')) verdicts.push(...(await armPb(standIn.url)));
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
  const t = totals();
  console.log(`\nturns=${perTurn.size} promptTokens=${t.tokens} cost=$${t.cost.toFixed(4)} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
  const code = exitCodeFor(verdicts);
  console.log(`exit ${code}: ${EXIT_CODE_MEANINGS[code]}`);
  try {
    rmSync(cwdPa, { recursive: true, force: true });
  } catch {
    // Scratch cwd; leaving it behind is harmless.
  }
  return code;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`HARNESS: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = PROBE_EXIT.HARNESS;
    });
}
