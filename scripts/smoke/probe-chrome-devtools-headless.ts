#!/usr/bin/env bun
/**
 * Environment probe for epic #1636 (EmbeddedAgent practicality): can the
 * `claude-sdk` arm launch a BROWSER MCP server headless, as the OS user that
 * runs the arm, and take a real screenshot? Measurement only -- this script
 * changes no production behavior and is not wired into CI, the same class of
 * tool as `probe-sdk-declared-mcp-and-task.ts`.
 *
 * THE FRAME IS GENERIC; THE INSTANCE IS NOT. The question is "can an
 * `claude-sdk` worker drive any browser MCP on this host with no display",
 * and `chrome-devtools-mcp` is only the instance at hand. The server's name
 * and the three tool names the prompts use live in `BROWSER_MCP` below; no
 * verdict logic reads them -- the classifier sees only plain readings
 * (connected / a tool fired / an image came back / an error string).
 *
 * WHAT IT RUNS. One isolated `CLAUDE_CONFIG_DIR` (`isolateClaudeConfigDir`,
 * checked with `verifyIsolationStrict`), whose `.claude.json` is rewritten
 * before each session to hold ONE user-scope `mcpServers` entry: the host's
 * own entry for the server, copied via `readUserScopeMcpServers()` (the
 * operator's real `~/.claude.json` is only READ, never written -- adding
 * `--headless` there would change their interactive TUI). Every session uses
 * the shipped design-II option shape: `settingSources: ['user', 'local']`,
 * no `strictMcpConfig`, the claude-sdk builtin's `enabledTools` allowlist.
 *
 *   headless          the copied entry + `--headless`.
 *                     Turn 1: call the server's list tool. Observed: the
 *                     server is `connected` in `system:init.mcp_servers` (or
 *                     the post-turn `mcpServerStatus()`) AND a `mcp__<server>__*`
 *                     tool fired (`PostToolUse` hook, as the sibling probes read it).
 *                     Turn 2 (only if turn 1 connected): navigate to
 *                     `about:blank` and take a screenshot. Observed: an IMAGE
 *                     content block with decoded size > 0 in a `PostToolUse`
 *                     `tool_response` (see "HOW AN IMAGE IS OBSERVED").
 *   headless-apt      ONLY if `headless` took no screenshot and the entry's
 *                     `--executablePath` is not already `/usr/bin/chromium-browser`:
 *                     the same, with that flag's value replaced (appended if
 *                     the entry had none). This is the snap trap: a snap
 *                     Chromium denies writes to dot-directories under `$HOME`,
 *                     which a profile directory needs. BOTH results are
 *                     recorded; the operational answer is "snap: X / apt: Y".
 *   control           the entry that WORKED (the as-configured one, or the apt
 *                     one -- so the executable is not a second variable) with
 *                     `--headless` REMOVED. If neither worked, the as-configured
 *                     entry without `--headless`. If the control ALSO takes a
 *                     screenshot the verdict says exactly that, and the flag is
 *                     not credited.
 *
 * All sessions run with `DISPLAY` and `WAYLAND_DISPLAY` unset in this
 * process's env (restored on exit): the arm's OS user is a service user with
 * no display, and with both unset the flag is the only variable between
 * `headless` and `control`. The ambient values are printed.
 *
 * HOW AN IMAGE IS OBSERVED. `ProbeSession` surfaces `tool_use` blocks from
 * `assistant` messages but not the `tool_result` blocks of the following
 * `user` message, so the harness cannot see an image. The `PostToolUse` hook
 * input carries the tool's `tool_response`, which this probe walks for an
 * `{ type: 'image', data | source.data }` block (`imageBytesIn`). The shape of
 * that response is printed with base64 payloads redacted to their length, so
 * a reader can check what the walk saw. If a server returned its image some
 * other way (a file path), the reading is `imageBytes = 0` and the redacted
 * shape shows why -- that is a finding, not a pass.
 *
 * RECORDED PROXY (pre-pr-completeness Q13). The isolated config dir and the
 * `--headless` / `--executablePath` edits are upstream of the chain under test
 * (the server launch and the tool call): they change how the arm arrives at
 * it, not what it does. The entry itself is provisioned from the real file.
 *
 * VERDICT AND EXIT CODES (`PROBE_EXIT`): 0 = measured, whichever way (a
 * working flag, a control that also works, no arm taking a screenshot); 1 =
 * INCONCLUSIVE (a turn did not settle, or nothing connected on ANY arm, so
 * the host cannot launch the server at all and no flag can be judged); 2 =
 * HARNESS (bad arguments, a missing or non-stdio host entry, unverified
 * isolation, an exception escaping `main`). The last stdout line is the
 * one-line `claude mcp add ...` the owner would run, built from the entry
 * that WORKED; this script never runs it.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user; a User-scope `chrome-devtools` MCP server in `~/.claude.json`
 * (`readUserScopeMcpServers()` requires that name); `npx` and a Chromium on
 * the host; `bun install` already run. BILLABLE -- up to 6 small turns
 * (2 per session, three sessions at most). A manual gate, never a CI job;
 * registered in `.claude/rules/smoke-verification-sdk-probes.md`.
 *
 * Usage: bun scripts/smoke/probe-chrome-devtools-headless.ts [--help]
 */

import './_env.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallbackMatcher, McpServerStatus, Options, SyncHookJSONOutput } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { mcpServerOf } from '../../packages/embedded-agent/src/mcp-names.js';
import { claudeSdkAgent } from '../../packages/server/src/services/embedded-agents/claude-sdk-builtin.ts';
import { readUserScopeMcpServers } from './probe-sdk-declared-mcp-and-task.js';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  snapshotIsolationEvidence,
  stamp,
  turnLine,
  turnSettled,
  verifyIsolationStrict,
  type IsolationEvidenceSnapshot,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

// ---------------------------------------------------------------------------
// The instance under test (the only chrome-devtools-specific constants)
// ---------------------------------------------------------------------------

export interface BrowserMcpSpec {
  /** The user-scope server name, as in `~/.claude.json` and `mcp__<server>__*`. */
  server: string;
  listTool: string;
  navigateTool: string;
  screenshotTool: string;
}

export const BROWSER_MCP: BrowserMcpSpec = {
  server: 'chrome-devtools',
  listTool: 'list_pages',
  navigateTool: 'navigate_page',
  screenshotTool: 'take_screenshot',
};

/** The apt-installed Chromium on the dogfood host (the snap trap's workaround). */
export const APT_CHROMIUM_PATH = '/usr/bin/chromium-browser';

/** Same model the sibling probes use; the measurement is about the host, not the model. */
const MODEL = 'claude-sonnet-5';

/** The environment variables a display-bound browser launch consults. */
export const DISPLAY_ENV_VARS = ['DISPLAY', 'WAYLAND_DISPLAY'] as const;

export function turnPrompts(spec: BrowserMcpSpec): { list: string; screenshot: string } {
  const tool = (name: string): string => `mcp__${spec.server}__${name}`;
  return {
    list:
      `Call the tool named ${tool(spec.listTool)} exactly once with no arguments. Then reply with ONLY the single word DONE. ` +
      'If that tool is not available to you, reply with ONLY the single word UNAVAILABLE and call nothing.',
    screenshot:
      `Call the tool named ${tool(spec.navigateTool)} exactly once to open the URL about:blank (arguments: type "url", url "about:blank"), ` +
      `then call the tool named ${tool(spec.screenshotTool)} exactly once with no arguments. Then reply with ONLY the single word DONE. ` +
      'If a tool is not available to you, reply with ONLY the single word UNAVAILABLE and call nothing further.',
  };
}

// ---------------------------------------------------------------------------
// Exit codes and the pure verdict layer (the part the unit test pins)
// ---------------------------------------------------------------------------

export const PROBE_EXIT = {
  /** The question was answered, whichever way. */
  MEASURED: 0,
  /** A turn did not settle, or nothing connected on any arm. */
  INCONCLUSIVE: 1,
  /** Harness failure -- nothing was measured. */
  HARNESS: 2,
} as const;

const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.MEASURED]: 'measured; the question was answered',
  [PROBE_EXIT.INCONCLUSIVE]: 'inconclusive; no reading could support a verdict',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
};

/** One arm's plain readings. No SDK types: the classifier sees only this. */
export interface ArmReading {
  /** Every turn this arm attempted produced a `result` (turnSettled). False means: unread, not negative. */
  settled: boolean;
  connected: boolean;
  /** At least one `mcp__<server>__*` tool completed in turn 1. */
  toolFired: boolean;
  /** Largest decoded image block seen in any tool response of this arm; 0 = none. */
  imageBytes: number;
  error: string | null;
}

export type Operational = 'headless-as-configured' | 'headless-with-apt-path' | 'none';

export interface ProbeVerdict {
  conclusive: boolean;
  /** Which entry took a screenshot with `--headless`, if any. */
  operational: Operational;
  /** True: the flag made the difference. False: it did not (control also works, or nothing works). Null: unread. */
  headlessCredited: boolean | null;
  verdict: string;
  /** Findings the owner must act on; printed as `STOP:` lines. */
  stops: string[];
}

export interface ProbeReadings {
  headless: ArmReading;
  /** `null` = the retry was not attempted (the as-configured arm worked, or its path was already the apt one). */
  apt: ArmReading | null;
  control: ArmReading;
}

export function screenshotTaken(r: ArmReading): boolean {
  return r.settled && r.connected && r.imageBytes > 0;
}

function describeArm(r: ArmReading): string {
  if (!r.settled) return 'unread';
  if (screenshotTaken(r)) return `screenshot ${r.imageBytes} bytes`;
  if (r.connected) return r.toolFired ? 'connected, tool fired, no image' : 'connected, no tool fired, no image';
  return 'not connected';
}

export function classifyProbe(r: ProbeReadings): ProbeVerdict {
  const named: Array<[string, ArmReading | null]> = [
    ['headless', r.headless],
    ['headless-apt', r.apt],
    ['control', r.control],
  ];
  const unread = named.filter(([, a]) => a !== null && !a.settled).map(([n]) => n);
  if (unread.length > 0) {
    return {
      conclusive: false,
      operational: 'none',
      headlessCredited: null,
      verdict: `INCONCLUSIVE: ${unread.join(', ')} did not settle, so it measured nothing`,
      stops: [],
    };
  }
  const arms = named.filter((n): n is [string, ArmReading] => n[1] !== null);
  if (!arms.some(([, a]) => a.connected)) {
    return {
      conclusive: false,
      operational: 'none',
      headlessCredited: null,
      verdict: `INCONCLUSIVE: nothing connected on any arm (${arms.map(([n]) => n).join(', ')}); the host cannot launch the server at all, so no flag can be judged`,
      stops: [],
    };
  }

  const aptTaken = r.apt !== null && screenshotTaken(r.apt);
  const operational: Operational = screenshotTaken(r.headless) ? 'headless-as-configured' : aptTaken ? 'headless-with-apt-path' : 'none';
  const controlTaken = screenshotTaken(r.control);
  const readings = `headless=[${describeArm(r.headless)}]${r.apt ? ` headless-apt=[${describeArm(r.apt)}]` : ''} control=[${describeArm(r.control)}]`;

  if (operational === 'none') {
    return {
      conclusive: true,
      operational,
      headlessCredited: false,
      verdict: `NO ARM TOOK A SCREENSHOT: ${readings}`,
      stops: ['no headless arm took a screenshot on this host; see the error column for the launch failure'],
    };
  }
  const via = operational === 'headless-as-configured' ? 'as configured' : `only after replacing --executablePath with ${APT_CHROMIUM_PATH}`;
  if (controlTaken) {
    return {
      conclusive: true,
      operational,
      headlessCredited: false,
      verdict: `BOTH SUCCEED: headless worked (${via}) but the control, without --headless and with no display, also took a screenshot, so --headless is not what made it work: ${readings}`,
      stops: ['the control succeeded: do not credit --headless'],
    };
  }
  return {
    conclusive: true,
    operational,
    headlessCredited: true,
    verdict: `HEADLESS WORKS (${via}); the control ${r.control.connected ? 'connected but took no screenshot' : 'did not connect'}: ${readings}`,
    stops: [],
  };
}

/** Exit code for the run's single verdict. `null` (no verdict reached) is INCONCLUSIVE, never MEASURED. */
export function exitCodeFor(verdict: Pick<ProbeVerdict, 'conclusive'> | null): number {
  if (verdict === null) return PROBE_EXIT.INCONCLUSIVE;
  return verdict.conclusive ? PROBE_EXIT.MEASURED : PROBE_EXIT.INCONCLUSIVE;
}

// ---------------------------------------------------------------------------
// Raw observations -> a reading
// ---------------------------------------------------------------------------

export interface ToolCallObservation {
  tool: string;
  /** Decoded size of the largest image block in the tool's response; 0 = none. */
  imageBytes: number;
}

export interface RawArmObservation {
  turn1Settled: boolean;
  turn2Ran: boolean;
  turn2Settled: boolean;
  /** The server's `status` in `system:init.mcp_servers`, or null if absent. */
  initStatus: string | null;
  /** The server's `status` in the post-turn `mcpServerStatus()`, or null if absent. */
  postStatus: string | null;
  /** Completed `mcp__<server>__*` calls in turn 1 / turn 2. */
  turn1Calls: ToolCallObservation[];
  turn2Calls: ToolCallObservation[];
  /** Status errors and `PostToolUseFailure` errors, in arrival order. */
  errors: string[];
}

const ERROR_MAX_CHARS = 300;

export function readArm(raw: RawArmObservation): ArmReading {
  const calls = [...raw.turn1Calls, ...raw.turn2Calls];
  const error = raw.errors.find((e) => e.trim().length > 0);
  return {
    settled: raw.turn1Settled && (!raw.turn2Ran || raw.turn2Settled),
    connected: raw.initStatus === 'connected' || raw.postStatus === 'connected',
    toolFired: raw.turn1Calls.length > 0,
    imageBytes: calls.reduce((max, c) => Math.max(max, c.imageBytes), 0),
    error: error === undefined ? null : error.trim().replace(/\s+/g, ' ').slice(0, ERROR_MAX_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Image observation (pure)
// ---------------------------------------------------------------------------

const IMAGE_WALK_MAX_DEPTH = 8;

function base64DecodedLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The decoded size of the LARGEST image block anywhere in a tool response, or
 * 0 when there is none. Accepts the MCP shape (`{ type: 'image', data }`), the
 * Anthropic message shape (`{ type: 'image', source: { data } }`), and either
 * wrapped in arrays / `content` objects, or serialized as a JSON string. An
 * image block with empty data is 0, not an image.
 */
export function imageBytesIn(value: unknown, depth = 0): number {
  if (depth > IMAGE_WALK_MAX_DEPTH) return 0;
  if (typeof value === 'string' && depth === 0) {
    const t = value.trimStart();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        return imageBytesIn(JSON.parse(value) as unknown, depth + 1);
      } catch {
        return 0;
      }
    }
    return 0;
  }
  if (Array.isArray(value)) return value.reduce<number>((max, v) => Math.max(max, imageBytesIn(v, depth + 1)), 0);
  if (!isRecord(value)) return 0;
  let best = 0;
  if (value.type === 'image') {
    const direct = typeof value.data === 'string' ? value.data : '';
    const nested = isRecord(value.source) && typeof value.source.data === 'string' ? value.source.data : '';
    best = base64DecodedLength(direct || nested);
  }
  for (const v of Object.values(value)) best = Math.max(best, imageBytesIn(v, depth + 1));
  return best;
}

const SHAPE_MAX_CHARS = 400;

/** A tool response rendered for the log with every long `data` string replaced by its length. */
export function summarizeResponseShape(value: unknown): string {
  const text = JSON.stringify(value, (key, v: unknown) => (key === 'data' && typeof v === 'string' && v.length > 64 ? `<${v.length} chars>` : v));
  const out = text === undefined ? '(undefined)' : text;
  return out.length > SHAPE_MAX_CHARS ? `${out.slice(0, SHAPE_MAX_CHARS)}...` : out;
}

// ---------------------------------------------------------------------------
// The server entry and its edits (pure)
// ---------------------------------------------------------------------------

export interface StdioEntry {
  type?: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  [extra: string]: unknown;
}

/** Validates a `~/.claude.json` `mcpServers` value as a stdio entry; `null` for anything else. Extra keys are kept verbatim. */
export function parseStdioEntry(raw: unknown): StdioEntry | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== undefined && raw.type !== 'stdio') return null;
  if (typeof raw.command !== 'string' || raw.command.length === 0) return null;
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) return null;
  if (raw.env !== undefined && !(isRecord(raw.env) && Object.values(raw.env).every((v) => typeof v === 'string'))) return null;
  return { ...raw, command: raw.command, args: [...args] } as StdioEntry;
}

const HEADLESS_FLAG = '--headless';
const EXECUTABLE_PATH_FLAG = '--executablePath';

const isHeadlessArg = (a: string): boolean => a === HEADLESS_FLAG || a.startsWith(`${HEADLESS_FLAG}=`);

export function withHeadless(entry: StdioEntry): StdioEntry {
  const args = entry.args.filter((a) => !isHeadlessArg(a));
  return { ...entry, args: [...args, HEADLESS_FLAG] };
}

export function withoutHeadless(entry: StdioEntry): StdioEntry {
  return { ...entry, args: entry.args.filter((a) => !isHeadlessArg(a)) };
}

/** The `--executablePath` value (either `--flag value` or `--flag=value`), or null when the entry has none. */
export function executablePathOf(entry: StdioEntry): string | null {
  for (let i = 0; i < entry.args.length; i++) {
    const a = entry.args[i];
    if (a === EXECUTABLE_PATH_FLAG) return entry.args[i + 1] ?? null;
    if (a.startsWith(`${EXECUTABLE_PATH_FLAG}=`)) return a.slice(EXECUTABLE_PATH_FLAG.length + 1);
  }
  return null;
}

/** Replaces the `--executablePath` value, or appends the flag when the entry has none. */
export function withExecutablePath(entry: StdioEntry, path: string): StdioEntry {
  const args = [...entry.args];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === EXECUTABLE_PATH_FLAG && i + 1 < args.length) {
      args[i + 1] = path;
      return { ...entry, args };
    }
    if (args[i].startsWith(`${EXECUTABLE_PATH_FLAG}=`)) {
      args[i] = `${EXECUTABLE_PATH_FLAG}=${path}`;
      return { ...entry, args };
    }
  }
  return { ...entry, args: [...args, EXECUTABLE_PATH_FLAG, path] };
}

/** Whether the snap-trap retry applies: the as-configured headless arm took no screenshot and its executable is not already the apt one. */
export function shouldRetryWithAptPath(entry: StdioEntry, headless: ArmReading): boolean {
  return !screenshotTaken(headless) && executablePathOf(entry) !== APT_CHROMIUM_PATH;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The one-line `claude mcp add` that registers `entry` at user scope. Never run by this script. */
export function registrationCommand(name: string, entry: StdioEntry): string {
  const env = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ['-e', shellQuote(`${k}=${v}`)]);
  return ['claude', 'mcp', 'add', '-s', 'user', ...env, shellQuote(name), '--', shellQuote(entry.command), ...entry.args.map(shellQuote)].join(' ');
}

export type ParsedArgs = { kind: 'run' } | { kind: 'help' } | { kind: 'error'; arg: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  return argv.length > 0 ? { kind: 'error', arg: argv[0] } : { kind: 'run' };
}

export interface TableRow {
  arm: string;
  /** `null` = not attempted. */
  reading: ArmReading | null;
}

/** The measured table: arm x { connected, tool fired, image bytes, error }. */
export function formatReadingsTable(rows: readonly TableRow[]): string {
  const header = ['arm', 'settled', 'connected', 'tool fired', 'image bytes', 'error'];
  const body = rows.map(({ arm, reading }) =>
    reading === null
      ? [arm, '-', '-', '-', '-', '(not attempted)']
      : [arm, String(reading.settled), String(reading.connected), String(reading.toolFired), String(reading.imageBytes), reading.error ?? '(none)'],
  );
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join(' | ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('-|-'), ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Live measurement (everything below needs a billed `claude` session)
// ---------------------------------------------------------------------------

const BASE_TOOLS: readonly string[] = claudeSdkAgent.enabledTools ?? [];
const USAGE_TEXT = 'Usage: bun scripts/smoke/probe-chrome-devtools-headless.ts [--help]';
const TURN_TIMEOUT_MS = 240_000;

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

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}   [${stamp()}]\n${'='.repeat(72)}`);
}

/** Records the server's completed tool calls (with image sizes) and tool failures. Observation only. */
class HookRecorder {
  turn: 1 | 2 = 1;
  readonly calls: Record<1 | 2, ToolCallObservation[]> = { 1: [], 2: [] };
  readonly failures: string[] = [];
  readonly shapes: string[] = [];
  readonly hooks: Options['hooks'];

  constructor(server: string) {
    const observe: HookCallbackMatcher = {
      hooks: [
        async (input): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name === 'PostToolUse' && mcpServerOf(input.tool_name) === server) {
            this.calls[this.turn].push({ tool: input.tool_name, imageBytes: imageBytesIn(input.tool_response) });
            this.shapes.push(`turn ${this.turn} ${input.tool_name} -> ${summarizeResponseShape(input.tool_response)}`);
          } else if (input.hook_event_name === 'PostToolUseFailure' && mcpServerOf(input.tool_name) === server) {
            this.failures.push(input.error);
          }
          return { continue: true };
        },
      ],
    };
    this.hooks = { PostToolUse: [observe], PostToolUseFailure: [observe] };
  }
}

function buildOptions(cwd: string, hooks: Options['hooks']): Options {
  return {
    executable: 'bun',
    cwd,
    model: MODEL,
    tools: [...BASE_TOOLS],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: ['user', 'local'],
    settings: { autoCompactEnabled: false, autoMemoryEnabled: false },
    hooks,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a probe subject. Follow instructions literally.' },
  };
}

interface LiveContext {
  spec: BrowserMcpSpec;
  configDir: string;
  cwd: string;
  preRunIsolation: IsolationEvidenceSnapshot;
  earlyIsolationChecked: boolean;
}

async function readPostStatus(s: ProbeSession, label: string, server: string): Promise<McpServerStatus | null> {
  try {
    const all = await s.q.mcpServerStatus();
    console.log(`${label}: mcpServerStatus() = ${JSON.stringify(all.map((x) => ({ name: x.name, status: x.status, error: x.error })))}`);
    return all.find((x) => x.name === server) ?? null;
  } catch (err) {
    console.log(`${label}: mcpServerStatus() threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One live session, one arm: seed the entry, run turn 1, and turn 2 only if turn 1 connected. */
async function runArm(ctx: LiveContext, label: string, entry: StdioEntry): Promise<ArmReading> {
  const { spec } = ctx;
  h(`${label} -- ${JSON.stringify({ command: entry.command, args: entry.args })}`);
  writeFileSync(join(ctx.configDir, '.claude.json'), JSON.stringify({ mcpServers: { [spec.server]: entry } }, null, 2));
  const prompts = turnPrompts(spec);
  const recorder = new HookRecorder(spec.server);
  const session = new ProbeSession({ label, options: buildOptions(ctx.cwd, recorder.hooks), pollUsage: false });
  console.log(`${label}: ready=${await session.waitForReady()}`);

  const t1 = await session.runTurn(prompts.list, TURN_TIMEOUT_MS);
  account(`${label}-t1`, t1);
  console.log(turnLine(`${label}-t1`, t1));
  const init = session.systemInit;
  const initStatus = init?.mcp_servers.find((s) => s.name === spec.server)?.status ?? null;
  console.log(`${label}: system:init mcp_servers = ${JSON.stringify(init?.mcp_servers ?? null)}`);
  console.log(`${label}: system:init server tools = ${JSON.stringify((init?.tools ?? []).filter((t) => mcpServerOf(t) === spec.server))}`);
  console.log(`${label}: turn 1 answer = ${JSON.stringify(t1.text.trim().slice(0, 120))}`);
  let post = await readPostStatus(session, label, spec.server);

  const connectedAfterTurn1 = initStatus === 'connected' || post?.status === 'connected';
  let t2: TurnOutcome | null = null;
  if (turnSettled(t1) && connectedAfterTurn1) {
    recorder.turn = 2;
    t2 = await session.runTurn(prompts.screenshot, TURN_TIMEOUT_MS);
    account(`${label}-t2`, t2);
    console.log(turnLine(`${label}-t2`, t2));
    console.log(`${label}: turn 2 answer = ${JSON.stringify(t2.text.trim().slice(0, 120))}`);
    post = (await readPostStatus(session, label, spec.server)) ?? post;
  } else {
    console.log(`${label}: turn 2 skipped (turn 1 settled=${turnSettled(t1)} connected=${connectedAfterTurn1})`);
  }
  for (const s of recorder.shapes) console.log(`${label}: ${s}`);
  for (const f of recorder.failures) console.log(`${label}: PostToolUseFailure: ${f}`);
  session.close();
  await session.waitForStreamEnd();

  if (!ctx.earlyIsolationChecked) {
    ctx.earlyIsolationChecked = true;
    const strict = verifyIsolationStrict(ctx.configDir, ctx.preRunIsolation);
    console.log(`${label}: EARLY isolation check (first billed session) -- before=${JSON.stringify(strict.before)} after=${JSON.stringify(strict.after)} ok=${strict.ok}`);
    if (!strict.ok) {
      throw new Error('no child-generated evidence appeared after the first billed session -- the CLAUDE_CONFIG_DIR override may not have reached the child');
    }
  }

  return readArm({
    turn1Settled: turnSettled(t1),
    turn2Ran: t2 !== null,
    turn2Settled: t2 !== null && turnSettled(t2),
    initStatus,
    postStatus: post?.status ?? null,
    turn1Calls: recorder.calls[1],
    turn2Calls: recorder.calls[2],
    errors: [post?.error ?? '', ...recorder.failures],
  });
}

/** Unsets the display variables for the whole run; returns the ambient values and a restore function. */
function scrubDisplayEnv(): { ambient: Record<string, string | undefined>; restore: () => void } {
  const ambient: Record<string, string | undefined> = {};
  for (const name of DISPLAY_ENV_VARS) {
    ambient[name] = process.env[name];
    delete process.env[name];
  }
  return {
    ambient,
    restore: () => {
      for (const name of DISPLAY_ENV_VARS) {
        const v = ambient[name];
        if (v !== undefined) process.env[name] = v;
      }
    },
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(USAGE_TEXT);
    return PROBE_EXIT.MEASURED;
  }
  if (parsed.kind === 'error') {
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${parsed.arg}`);
    return PROBE_EXIT.HARNESS;
  }

  const spec = BROWSER_MCP;
  const hostEntry = parseStdioEntry(readUserScopeMcpServers()[spec.server]);
  if (hostEntry === null) {
    console.error(`HARNESS: the host's user-scope '${spec.server}' entry is not a stdio server with a command (run \`claude mcp get ${spec.server}\`)`);
    return PROBE_EXIT.HARNESS;
  }

  const configDir = isolateClaudeConfigDir('chrome-devtools-headless');
  // Snapshotted BEFORE the first `.claude.json` seed, so the strict check's baseline predates both the seed and the child's writes.
  const preRunIsolation = snapshotIsolationEvidence(configDir);
  const cwd = mkdtempSync(join(tmpdir(), 'probe-chrome-devtools-headless-cwd-'));
  const ctx: LiveContext = { spec, configDir, cwd, preRunIsolation, earlyIsolationChecked: false };
  const display = scrubDisplayEnv();
  h(`probe-chrome-devtools-headless -- server=${spec.server} config=${configDir} cwd=${cwd}`);
  console.log(`host entry (copied verbatim, real ~/.claude.json untouched): ${JSON.stringify({ command: hostEntry.command, args: hostEntry.args })}`);
  console.log(`ambient display env, unset for every session: ${JSON.stringify(display.ambient)}`);

  let readings: ProbeReadings;
  let workedEntry: StdioEntry | null = null;
  try {
    const headlessEntry = withHeadless(hostEntry);
    const headless = await runArm(ctx, 'headless', headlessEntry);
    let apt: ArmReading | null = null;
    let aptEntry: StdioEntry | null = null;
    if (headless.settled && shouldRetryWithAptPath(hostEntry, headless)) {
      aptEntry = withHeadless(withExecutablePath(hostEntry, APT_CHROMIUM_PATH));
      apt = await runArm(ctx, 'headless-apt', aptEntry);
    }
    if (screenshotTaken(headless)) workedEntry = headlessEntry;
    else if (apt !== null && screenshotTaken(apt)) workedEntry = aptEntry;
    const controlBase = workedEntry ?? hostEntry;
    const control = await runArm(ctx, 'control', withoutHeadless(controlBase));
    readings = { headless, apt, control };
  } finally {
    display.restore();
  }

  h('ISOLATION');
  const finalIso = verifyIsolationStrict(configDir, preRunIsolation);
  console.log(`config dir ${configDir}: before=${JSON.stringify(finalIso.before)} after=${JSON.stringify(finalIso.after)} ok=${finalIso.ok}`);
  if (!finalIso.ok) {
    console.error('HARNESS: the CLAUDE_CONFIG_DIR override did not reach the child; every isolation claim above is void');
    return PROBE_EXIT.HARNESS;
  }

  h('MEASURED TABLE');
  console.log(
    formatReadingsTable([
      { arm: 'headless', reading: readings.headless },
      { arm: 'headless-apt', reading: readings.apt },
      { arm: 'control', reading: readings.control },
    ]),
  );

  h('VERDICT');
  const verdict = classifyProbe(readings);
  console.log(verdict.verdict);
  for (const s of verdict.stops) console.log(`STOP: ${s}`);
  const turnTotals = [...perTurn.values()].reduce((acc, v) => ({ tokens: acc.tokens + v.tokens, cost: acc.cost + v.cost }), { tokens: 0, cost: 0 });
  console.log(`turns=${perTurn.size} promptTokens=${turnTotals.tokens} cost=$${turnTotals.cost.toFixed(4)} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
  const code = exitCodeFor(verdict);
  console.log(`exit ${code}: ${EXIT_CODE_MEANINGS[code]}`);
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // Scratch cwd; leaving it behind is harmless.
  }
  // The registration line is the LAST stdout line. It is printed, never run.
  console.log(workedEntry !== null ? registrationCommand(spec.server, workedEntry) : 'NO WORKING ENTRY MEASURED: no registration command to offer');
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
