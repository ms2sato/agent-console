/**
 * Pure metric functions for a Phase 6 embedded-agent run: worker NDJSON
 * events, the CLI transcript (cost) and the server journal (clock). No I/O and
 * no process access -- the CLI (scripts/phase6-analyze-run.ts) reads the
 * files and calls these. This file is also the single writer of the readiness
 * table's row vocabulary (`formatReadinessRows`).
 *
 * Every function is defensive about odd input: values that are not objects or
 * lack the expected fields are ignored, never thrown on.
 */

/**
 * The create_timer refusal text returned while a run_process of the session is
 * live. Pinned ONCE here; the sibling test reads the server source as text and
 * fails if the server wording drifts from it.
 */
export const TIMER_REFUSED_PROCESS_RUNNING_TEXT =
  'This process reports back on its own: its remaining output and its exit arrive as new turns, bounded by its timeoutSeconds. ' +
  'Do not poll get_session_status or list_processes, and do not create a timer to wait for it. ' +
  'End your turn; if the process is waiting for input, answer it with write_process_response instead of a timer.';

/** A create_timer attempt is eligible for the refusal below this interval. */
const REFUSAL_INTERVAL_LIMIT_SECONDS = 120;
/** A turn with at least this many polls is "Cause A" (a polling loop). */
const CAUSE_A_POLLS_PER_TURN = 10;
/** Process duration threshold for the "finished within 2 s" share. */
const QUICK_PROCESS_SECONDS = 2;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Strip a leading `mcp__<server>__` prefix; built-in names have none. */
function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '');
}

/**
 * Unwrap a tool-result string. It is usually a JSON array of content blocks
 * `[{"type":"text","text":"..."}]`; the text blocks are joined. Anything else
 * is returned unchanged.
 */
export function toolResultText(result: string): string {
  try {
    const parsed: unknown = JSON.parse(result);
    if (Array.isArray(parsed)) {
      const texts: string[] = [];
      for (const block of parsed) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) return texts.join('\n');
    }
  } catch {
    // not JSON: fall through to the raw string
  }
  return result;
}

function reportsExited(result: string): boolean {
  const text = toolResultText(result);
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed.exited === true;
  } catch {
    return /"exited"\s*:\s*true/.test(text);
  }
}

export interface NdjsonMetrics {
  timers: { create: number; delete: number; reset: number };
  createTimerEligible: number;
  createTimerRefused: number;
  createTimerAccepted: number;
  getSessionStatusSelf: number;
  getSessionStatusOther: number;
  listProcesses: number;
  causeATurns: number;
  causeAPolls: number;
  causeBPolls: number;
  maxPollsInOneTurn: number;
  toolCalls: number;
  turns: number;
  runProcess: number;
  runProcessInlineExited: number;
  writeProcessResponse: number;
  writeMemo: number;
  todoWrite: number;
  contextUsage: { n: number; first: number; max: number; mean: number };
  modelHistogram: Record<string, number>;
  substituteChannels: {
    createConditionalWakeup: number;
    sendMessageToSelf: number;
    sleepRunProcess: number;
  };
}

interface ToolCall {
  turnId: string;
  callId: string;
  name: string;
  args: UnknownRecord;
}

export function computeNdjsonMetrics(events: readonly unknown[], sessionId: string): NdjsonMetrics {
  const calls: ToolCall[] = [];
  const resultsByCallId = new Map<string, { ok: unknown; result: string }>();
  const contextTokens: number[] = [];
  const modelHistogram: Record<string, number> = {};
  let turns = 0;

  for (const event of events) {
    if (!isRecord(event)) continue;
    switch (event.type) {
      case 'tool-call':
        if (typeof event.name === 'string') {
          calls.push({
            turnId: String(event.turnId ?? ''),
            callId: String(event.callId ?? ''),
            name: stripMcpPrefix(event.name),
            args: isRecord(event.args) ? event.args : {},
          });
        }
        break;
      case 'tool-result':
        if (event.callId !== undefined) {
          resultsByCallId.set(String(event.callId), {
            ok: event.ok,
            result: typeof event.result === 'string' ? event.result : '',
          });
        }
        break;
      case 'user-message':
        turns += 1;
        break;
      case 'context-usage':
        if (isNumber(event.promptTokens)) {
          contextTokens.push(event.promptTokens);
          const model = typeof event.model === 'string' && event.model !== '' ? event.model : 'unknown';
          modelHistogram[model] = (modelHistogram[model] ?? 0) + 1;
        }
        break;
      default:
        break;
    }
  }

  const named = (name: string): ToolCall[] => calls.filter((c) => c.name === name);

  const timerCreates = named('create_timer');
  const eligible = timerCreates.filter(
    (c) =>
      isNumber(c.args.intervalSeconds) &&
      c.args.intervalSeconds < REFUSAL_INTERVAL_LIMIT_SECONDS &&
      !(isNumber(c.args.backoffFactor) && c.args.backoffFactor > 1),
  );
  const refused = eligible.filter((c) => {
    const outcome = resultsByCallId.get(c.callId);
    if (!outcome || outcome.ok !== false) return false;
    return (
      outcome.result.includes(TIMER_REFUSED_PROCESS_RUNNING_TEXT) ||
      toolResultText(outcome.result).includes(TIMER_REFUSED_PROCESS_RUNNING_TEXT)
    );
  });

  const statusCalls = named('get_session_status');
  const self = statusCalls.filter((c) => c.args.sessionId === sessionId).length;
  const listProcesses = named('list_processes');

  const pollsByTurn = new Map<string, number>();
  for (const c of [...statusCalls, ...listProcesses]) {
    pollsByTurn.set(c.turnId, (pollsByTurn.get(c.turnId) ?? 0) + 1);
  }
  let causeATurns = 0;
  let causeAPolls = 0;
  let causeBPolls = 0;
  let maxPollsInOneTurn = 0;
  for (const count of pollsByTurn.values()) {
    if (count >= CAUSE_A_POLLS_PER_TURN) {
      causeATurns += 1;
      causeAPolls += count;
    } else {
      causeBPolls += count;
    }
    maxPollsInOneTurn = Math.max(maxPollsInOneTurn, count);
  }

  const runProcess = named('run_process');
  const inlineExited = runProcess.filter((c) => {
    const outcome = resultsByCallId.get(c.callId);
    return outcome !== undefined && reportsExited(outcome.result);
  }).length;

  const n = contextTokens.length;
  const contextUsage =
    n === 0
      ? { n: 0, first: 0, max: 0, mean: 0 }
      : {
          n,
          first: contextTokens[0],
          max: Math.max(...contextTokens),
          mean: Math.round(contextTokens.reduce((a, b) => a + b, 0) / n),
        };

  return {
    timers: {
      create: timerCreates.length,
      delete: named('delete_timer').length,
      reset: named('reset_timer').length,
    },
    createTimerEligible: eligible.length,
    createTimerRefused: refused.length,
    createTimerAccepted: eligible.length - refused.length,
    getSessionStatusSelf: self,
    getSessionStatusOther: statusCalls.length - self,
    listProcesses: listProcesses.length,
    causeATurns,
    causeAPolls,
    causeBPolls,
    maxPollsInOneTurn,
    toolCalls: calls.length,
    turns,
    runProcess: runProcess.length,
    runProcessInlineExited: inlineExited,
    writeProcessResponse: named('write_process_response').length,
    writeMemo: named('write_memo').length,
    todoWrite: named('TodoWrite').length,
    contextUsage,
    modelHistogram,
    substituteChannels: {
      createConditionalWakeup: named('create_conditional_wakeup').length,
      sendMessageToSelf: named('send_session_message').filter((c) => c.args.toSessionId === sessionId)
        .length,
      sleepRunProcess: runProcess.filter(
        (c) => typeof c.args.command === 'string' && c.args.command.trim().startsWith('sleep'),
      ).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript cost
// ---------------------------------------------------------------------------

/** List-price USD per million tokens. */
export interface Prices {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export const DEFAULT_PRICES: Prices = { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 };

export type TranscriptCost =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'ok';
      calls: number;
      input: number;
      cacheCreation: number;
      cacheRead: number;
      output: number;
      usd: number;
    };

/**
 * Cost from CLI transcript records. One API call can be written as several
 * assistant records sharing a `message.id`; the LAST record's usage is the
 * call's usage. A record without a message id is its own call.
 */
export function computeTranscriptCost(
  records: readonly unknown[],
  prices: Prices = DEFAULT_PRICES,
): TranscriptCost {
  const usageByCall = new Map<string, UnknownRecord>();
  let anonymous = 0;
  for (const record of records) {
    if (!isRecord(record) || record.type !== 'assistant') continue;
    const message = isRecord(record.message) ? record.message : {};
    const usage = isRecord(message.usage) ? message.usage : {};
    const key = typeof message.id === 'string' ? `id:${message.id}` : `anon:${anonymous++}`;
    usageByCall.set(key, usage);
  }
  if (usageByCall.size === 0) {
    return { status: 'unavailable', reason: 'no assistant records in the transcript' };
  }
  const sum = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  const field = (usage: UnknownRecord, key: string): number => (isNumber(usage[key]) ? usage[key] : 0);
  for (const usage of usageByCall.values()) {
    sum.input += field(usage, 'input_tokens');
    sum.cacheCreation += field(usage, 'cache_creation_input_tokens');
    sum.cacheRead += field(usage, 'cache_read_input_tokens');
    sum.output += field(usage, 'output_tokens');
  }
  const usd =
    (sum.input * prices.input +
      sum.cacheCreation * prices.cacheCreation +
      sum.cacheRead * prices.cacheRead +
      sum.output * prices.output) /
    1e6;
  return { status: 'ok', calls: usageByCall.size, ...sum, usd };
}

// ---------------------------------------------------------------------------
// Server clock
// ---------------------------------------------------------------------------

export interface ServerClockMetrics {
  processesStarted: number;
  processesExited: number;
  eligibleAttempts: number;
  accepted: number;
  refused: number;
  /** Accepted timers created while at least one process of the session was live. */
  acceptedWhileLive: number;
  /**
   * Accepted timers created when NO process of the session was live (every
   * started process had already exited, or none had started). This is the
   * correct outcome: the exit notice may simply not have reached the model yet.
   */
  acceptedAfterExit: number;
  refusedWhileLive: number;
  refusedNoneLive: number;
  /** Seconds from the latest exit at or before an accepted timer to that timer. */
  exitToAcceptLag: { medianSeconds: number | null; maxSeconds: number | null };
  processDuration: {
    medianSeconds: number | null;
    maxSeconds: number | null;
    atMost2sCount: number;
    total: number;
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeServerClock(
  journalLines: readonly unknown[],
  sessionId: string,
): ServerClockMetrics {
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  for (const line of journalLines) {
    if (!isRecord(line) || !isNumber(line.time) || typeof line.processId !== 'string') continue;
    if (line.msg === 'Process started' && line.sessionId === sessionId) {
      start.set(line.processId, line.time);
    } else if (line.msg === 'Process exited' && start.has(line.processId)) {
      end.set(line.processId, line.time);
    }
  }

  const acceptedTimes: number[] = [];
  const refusedTimes: number[] = [];
  for (const line of journalLines) {
    if (!isRecord(line) || line.sessionId !== sessionId || !isNumber(line.time)) continue;
    if (line.msg === 'Timer created') {
      const backoff = isNumber(line.backoffFactor) && line.backoffFactor !== 0 ? line.backoffFactor : 1;
      if (
        isNumber(line.intervalSeconds) &&
        line.intervalSeconds < REFUSAL_INTERVAL_LIMIT_SECONDS &&
        backoff <= 1
      ) {
        acceptedTimes.push(line.time);
      }
    } else if (line.msg === 'create_timer refused: live run_process') {
      refusedTimes.push(line.time);
    }
  }

  const isLive = (t: number): boolean => {
    for (const [processId, startedAt] of start) {
      const endedAt = end.get(processId);
      if (startedAt <= t && (endedAt === undefined || endedAt > t)) return true;
    }
    return false;
  };

  const lags: number[] = [];
  for (const t of acceptedTimes) {
    let latestExit: number | undefined;
    for (const endedAt of end.values()) {
      if (endedAt <= t && (latestExit === undefined || endedAt > latestExit)) latestExit = endedAt;
    }
    if (latestExit !== undefined) lags.push((t - latestExit) / 1000);
  }

  const durations: number[] = [];
  for (const [processId, endedAt] of end) {
    durations.push((endedAt - (start.get(processId) ?? endedAt)) / 1000);
  }

  const acceptedWhileLive = acceptedTimes.filter(isLive).length;
  const refusedWhileLive = refusedTimes.filter(isLive).length;
  return {
    processesStarted: start.size,
    processesExited: end.size,
    eligibleAttempts: acceptedTimes.length + refusedTimes.length,
    accepted: acceptedTimes.length,
    refused: refusedTimes.length,
    acceptedWhileLive,
    acceptedAfterExit: acceptedTimes.length - acceptedWhileLive,
    refusedWhileLive,
    refusedNoneLive: refusedTimes.length - refusedWhileLive,
    exitToAcceptLag: {
      medianSeconds: median(lags),
      maxSeconds: lags.length === 0 ? null : Math.max(...lags),
    },
    processDuration: {
      medianSeconds: median(durations),
      maxSeconds: durations.length === 0 ? null : Math.max(...durations),
      atMost2sCount: durations.filter((d) => d <= QUICK_PROCESS_SECONDS).length,
      total: durations.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

export interface ReadinessRow {
  label: string;
  value: string;
  /** Set where the value is a single comparable number (baseline delta). */
  num?: number;
}

const UNAVAILABLE = 'UNAVAILABLE';
const NOT_AVAILABLE = 'n/a';

function seconds(value: number | null): string {
  return value === null ? NOT_AVAILABLE : value.toFixed(1);
}

export function formatReadinessRows(m: {
  ndjson: NdjsonMetrics;
  cost: TranscriptCost;
  serverClock?: ServerClockMetrics;
}): ReadinessRow[] {
  const { ndjson: n, cost, serverClock: clock } = m;
  const timerTotal = n.timers.create + n.timers.delete + n.timers.reset;
  const u = n.contextUsage;
  const models = Object.entries(n.modelHistogram)
    .map(([name, count]) => `${name} (${count})`)
    .join(', ');
  const sc = n.substituteChannels;

  const rows: ReadinessRow[] = [
    {
      label: 'Timer calls create / delete / reset',
      value: `${timerTotal} (${n.timers.create} / ${n.timers.delete} / ${n.timers.reset})`,
      num: timerTotal,
    },
    {
      label: 'create_timer attempts under the refusal condition (interval < 120 s, no backoffFactor above 1)',
      value: String(n.createTimerEligible),
      num: n.createTimerEligible,
    },
    { label: '... refused by the server', value: String(n.createTimerRefused), num: n.createTimerRefused },
    { label: '... accepted', value: String(n.createTimerAccepted), num: n.createTimerAccepted },
    {
      label: 'Self get_session_status',
      value: `${n.getSessionStatusSelf} (${n.getSessionStatusSelf + n.getSessionStatusOther} total)`,
      num: n.getSessionStatusSelf,
    },
    { label: 'list_processes', value: String(n.listProcesses), num: n.listProcesses },
    {
      label: 'Polling Cause A turns (>=10 polls in one turn) / their polls / Cause B polls',
      value: `${n.causeATurns} / ${n.causeAPolls} / ${n.causeBPolls}`,
    },
    cost.status === 'ok'
      ? { label: 'Unique API calls (dedup by message.id)', value: String(cost.calls), num: cost.calls }
      : { label: 'Unique API calls (dedup by message.id)', value: UNAVAILABLE },
    cost.status === 'ok'
      ? { label: 'Cost, list-price equivalent, dedup', value: `${cost.usd.toFixed(1)} USD`, num: cost.usd }
      : { label: 'Cost, list-price equivalent, dedup', value: UNAVAILABLE },
    { label: 'Tool calls', value: String(n.toolCalls), num: n.toolCalls },
    { label: 'Turns (user-message)', value: String(n.turns), num: n.turns },
    { label: 'run_process calls', value: String(n.runProcess), num: n.runProcess },
    {
      label: 'run_process finished inline (exited: true)',
      value: String(n.runProcessInlineExited),
      num: n.runProcessInlineExited,
    },
    { label: 'write_process_response', value: String(n.writeProcessResponse), num: n.writeProcessResponse },
    { label: 'write_memo / TodoWrite', value: `${n.writeMemo} / ${n.todoWrite}` },
    {
      label:
        'New substitute channel (create_conditional_wakeup / sleep run_process / send_session_message to self)',
      value: `${sc.createConditionalWakeup} / ${sc.sleepRunProcess} / ${sc.sendMessageToSelf}`,
    },
    {
      label: 'context-usage n / first / max / mean',
      value: `${u.n} / ${u.first} / ${u.max} / ${u.mean}`,
    },
    { label: 'Model', value: models === '' ? NOT_AVAILABLE : models },
  ];

  if (clock) {
    const quick = clock.processDuration;
    rows.push(
      {
        label: 'Processes finished within 2 s',
        value: quick.total === 0 ? NOT_AVAILABLE : `${quick.atMost2sCount} of ${quick.total}`,
      },
      {
        label: 'Exit notice lag: accepted timers after the last exit, median / max (s)',
        value: `${seconds(clock.exitToAcceptLag.medianSeconds)} / ${seconds(clock.exitToAcceptLag.maxSeconds)}`,
      },
      {
        label: 'Accepted while a process was live / after the last exit',
        value: `${clock.acceptedWhileLive} / ${clock.acceptedAfterExit}`,
      },
      {
        label: 'Refused while live / with none live',
        value: `${clock.refusedWhileLive} / ${clock.refusedNoneLive}`,
      },
    );
  }
  return rows;
}

/** Signed difference; one decimal when the difference is not an integer. */
export function formatDelta(current: number, baseline: number): string {
  const diff = current - baseline;
  if (Number.isInteger(diff)) return diff > 0 ? `+${diff}` : String(diff);
  const text = diff.toFixed(1);
  if (Number(text) === 0) return '0';
  return diff > 0 ? `+${text}` : text;
}
