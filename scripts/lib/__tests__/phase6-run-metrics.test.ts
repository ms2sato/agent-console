/**
 * Reach, measured by mutating the predicate once and running this file and
 * phase6-analyze-run-cli.test.ts (which tests failed; no mutant passes):
 *
 * - self/other split dropped (self = every get_session_status):
 *     computeNdjsonMetrics polling > counts a 12-poll turn as Self only for the matching sessionId
 *     computeNdjsonMetrics polling > splits Cause A (>=10 polls in a turn) from Cause B and separates self from other
 *     formatReadinessRows vocabulary > renders composite values
 * - eligible: backoff condition dropped:
 *     computeNdjsonMetrics create_timer > applies the eligibility condition and requires ok:false plus the literal for a refusal
 * - eligible: interval limit 120 -> <=120:
 *     boundary values of each predicate > a create_timer at exactly 120 s is not eligible, 119 s is
 * - refused: literal check dropped (ok:false only):
 *     computeNdjsonMetrics create_timer > applies the eligibility condition and requires ok:false plus the literal for a refusal
 * - refused: ok:false check dropped:
 *     computeNdjsonMetrics create_timer > applies the eligibility condition and requires ok:false plus the literal for a refusal
 * - inline exited: any 'exited' key counts:
 *     computeNdjsonMetrics run_process > counts inline exits only when exited is true
 * - Cause A threshold >=10 -> >10:
 *     boundary values of each predicate > 9 polls in one turn are Cause B, 10 are Cause A
 * - Cause A counts only get_session_status (list_processes excluded):
 *     boundary values of each predicate > 9 polls in one turn are Cause B, 10 are Cause A
 *     computeNdjsonMetrics polling > splits Cause A (>=10 polls in a turn) from Cause B and separates self from other
 * - dedup: LAST usage -> FIRST usage:
 *     computeTranscriptCost > dedups by message.id taking the last usage, ignores non-assistant, keeps id-less records apart
 * - dedup: every record is its own call:
 *     computeTranscriptCost > dedups by message.id taking the last usage, ignores non-assistant, keeps id-less records apart
 * - cost: assistant filter dropped:
 *     computeTranscriptCost > dedups by message.id taking the last usage, ignores non-assistant, keeps id-less records apart
 *     phase6-analyze-run CLI > exits 2 and shows UNAVAILABLE cost for a transcript without assistant records
 * - price: cache write/read swapped:
 *     boundary values of each predicate > prices each token class at its own rate (four different quantities)
 * - substitute: send_session_message to self counts every send:
 *     computeNdjsonMetrics misc counters > counts substitute channels, context usage and models
 * - substitute: sleep match startsWith -> includes:
 *     boundary values of each predicate > only a command that STARTS with sleep is a sleep wait
 * - server clock: lag uses EARLIEST exit:
 *     computeServerClock > measures lag from the latest exit and ignores ineligible timers and other sessions
 * - server clock: isLive end>t -> end>=t:
 *     boundary values of each predicate > server clock > an accept at the very millisecond of the exit is after the exit, not live
 * - server clock: median of even count takes upper middle:
 *     boundary values of each predicate > server clock > the median of an even count is the mean of the two middle values
 * - server clock: <=2 s -> <2 s:
 *     computeServerClock > counts durations at most 2 s inclusive
 * - server clock: refused session filter dropped:
 *     computeServerClock > measures lag from the latest exit and ignores ineligible timers and other sessions
 * - tool name prefix strip dropped: every test that builds prefixed tool names fails (all of the tool-call describes and the CLI baseline case)
 * - turns counts assistant-message too:
 *     boundary values of each predicate > counts a turn only for user-message, not for assistant-message
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TIMER_REFUSED_PROCESS_RUNNING_TEXT,
  computeNdjsonMetrics,
  computeServerClock,
  computeTranscriptCost,
  formatDelta,
  formatReadinessRows,
  toolResultText,
} from '../phase6-run-metrics.js';

const SID = 'sess-self';
const PREFIX = 'mcp__agent-console__';

let nextCall = 0;
function call(turnId: string, name: string, args: Record<string, unknown> = {}) {
  const callId = `c${nextCall++}`;
  return { type: 'tool-call', turnId, callId, name, args };
}
function result(callId: string, ok: boolean, text: string) {
  return { type: 'tool-result', turnId: 't', callId, ok, result: text };
}
function wrap(json: string): string {
  return JSON.stringify([{ type: 'text', text: json }]);
}

describe('computeNdjsonMetrics polling', () => {
  it('splits Cause A (>=10 polls in a turn) from Cause B and separates self from other', () => {
    const events: unknown[] = [];
    for (let i = 0; i < 12; i++) events.push(call('t1', `${PREFIX}get_session_status`, { sessionId: SID }));
    events.push(call('t2', `${PREFIX}get_session_status`, { sessionId: SID }));
    events.push(call('t2', `${PREFIX}list_processes`));
    events.push(call('t3', `${PREFIX}get_session_status`, { sessionId: 'someone-else' }));
    events.push(call('t3', `${PREFIX}get_session_status`));
    const m = computeNdjsonMetrics(events, SID);
    expect(m.causeATurns).toBe(1);
    expect(m.causeAPolls).toBe(12);
    expect(m.causeBPolls).toBe(2 + 2);
    expect(m.getSessionStatusSelf).toBe(13);
    expect(m.getSessionStatusOther).toBe(2);
    expect(m.listProcesses).toBe(1);
    expect(m.maxPollsInOneTurn).toBe(12);
  });

  it('counts a 12-poll turn as Self only for the matching sessionId', () => {
    const events = Array.from({ length: 12 }, () =>
      call('t1', `${PREFIX}get_session_status`, { sessionId: 'other' }),
    );
    const m = computeNdjsonMetrics(events, SID);
    expect(m.getSessionStatusSelf).toBe(0);
    expect(m.getSessionStatusOther).toBe(12);
  });
});

describe('computeNdjsonMetrics create_timer', () => {
  it('applies the eligibility condition and requires ok:false plus the literal for a refusal', () => {
    const refusedCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 30 });
    const wrongTextCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 30 });
    const acceptedCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 60 });
    const backoffCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 30, backoffFactor: 2 });
    const longCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 300 });
    const okWithTextCall = call('t', `${PREFIX}create_timer`, { intervalSeconds: 30 });
    const events = [
      refusedCall,
      result(refusedCall.callId, false, wrap(TIMER_REFUSED_PROCESS_RUNNING_TEXT)),
      wrongTextCall,
      result(wrongTextCall.callId, false, 'some other failure'),
      acceptedCall,
      result(acceptedCall.callId, true, 'created'),
      backoffCall,
      longCall,
      okWithTextCall,
      result(okWithTextCall.callId, true, TIMER_REFUSED_PROCESS_RUNNING_TEXT),
    ];
    const m = computeNdjsonMetrics(events, SID);
    expect(m.timers.create).toBe(6);
    expect(m.createTimerEligible).toBe(4);
    expect(m.createTimerRefused).toBe(1);
    expect(m.createTimerAccepted).toBe(3);
  });

  it('counts delete and reset timers and ignores a non-prefixed lookalike name', () => {
    const events = [
      call('t', `${PREFIX}delete_timer`),
      call('t', `${PREFIX}reset_timer`),
      call('t', 'my_create_timer'),
    ];
    const m = computeNdjsonMetrics(events, SID);
    expect(m.timers).toEqual({ create: 0, delete: 1, reset: 1 });
  });
});

describe('computeNdjsonMetrics run_process', () => {
  it('counts inline exits only when exited is true', () => {
    const a = call('t', `${PREFIX}run_process`, { command: 'echo a' });
    const b = call('t', `${PREFIX}run_process`, { command: 'echo b' });
    const c = call('t', `${PREFIX}run_process`, { command: 'echo c' });
    const d = call('t', `${PREFIX}run_process`, { command: 'echo d' });
    const events = [
      a,
      result(a.callId, true, wrap('{"exited":true,"exitCode":0}')),
      b,
      result(b.callId, true, wrap('{"exited":false}')),
      c,
      result(c.callId, true, wrap('{"processId":"p"}')),
      d,
      result(d.callId, true, 'plain text "exited": true'),
    ];
    const m = computeNdjsonMetrics(events, SID);
    expect(m.runProcess).toBe(4);
    expect(m.runProcessInlineExited).toBe(2);
  });

  it('unwraps content blocks and falls back to the raw string', () => {
    expect(toolResultText(wrap('hello'))).toBe('hello');
    expect(toolResultText('not json')).toBe('not json');
  });
});

describe('computeNdjsonMetrics misc counters', () => {
  it('counts substitute channels, context usage and models', () => {
    const events = [
      { type: 'user-message' },
      { type: 'user-message' },
      call('t', `${PREFIX}create_conditional_wakeup`),
      call('t', `${PREFIX}send_session_message`, { toSessionId: SID }),
      call('t', `${PREFIX}send_session_message`, { toSessionId: 'other' }),
      call('t', `${PREFIX}run_process`, { command: '  sleep 5' }),
      call('t', `${PREFIX}write_process_response`),
      call('t', `${PREFIX}write_memo`),
      call('t', 'TodoWrite'),
      { type: 'context-usage', promptTokens: 100, model: 'm1' },
      { type: 'context-usage', promptTokens: 201 },
      { type: 'context-usage', promptTokens: 300, model: 'm1' },
    ];
    const m = computeNdjsonMetrics(events, SID);
    expect(m.turns).toBe(2);
    expect(m.substituteChannels).toEqual({
      createConditionalWakeup: 1,
      sendMessageToSelf: 1,
      sleepRunProcess: 1,
    });
    expect(m.writeProcessResponse).toBe(1);
    expect(m.writeMemo).toBe(1);
    expect(m.todoWrite).toBe(1);
    expect(m.contextUsage).toEqual({ n: 3, first: 100, max: 300, mean: 200 });
    expect(m.modelHistogram).toEqual({ m1: 2, unknown: 1 });
  });

  it('does not throw on odd input', () => {
    const m = computeNdjsonMetrics([null, 7, 'x', [], {}, { type: 'tool-call' }, { type: 'tool-result' }], SID);
    expect(m.toolCalls).toBe(0);
  });
});

describe('boundary values', () => {
  it('empty NDJSON gives all zeros', () => {
    const m = computeNdjsonMetrics([], SID);
    expect(m.turns).toBe(0);
    expect(m.toolCalls).toBe(0);
    expect(m.maxPollsInOneTurn).toBe(0);
    expect(m.contextUsage).toEqual({ n: 0, first: 0, max: 0, mean: 0 });
    expect(m.modelHistogram).toEqual({});
    expect(m.timers).toEqual({ create: 0, delete: 0, reset: 0 });
  });

  it('empty transcript is unavailable and the table never shows 0 USD', () => {
    const cost = computeTranscriptCost([]);
    expect(cost.status).toBe('unavailable');
    const rows = formatReadinessRows({ ndjson: computeNdjsonMetrics([], SID), cost });
    const costRow = rows.find((r) => r.label === 'Cost, list-price equivalent, dedup');
    expect(costRow?.value).toBe('UNAVAILABLE');
    expect(rows.find((r) => r.label === 'Unique API calls (dedup by message.id)')?.value).toBe('UNAVAILABLE');
    expect(rows.map((r) => r.value).join('\n')).not.toContain('0 USD');
  });

  it('empty journal gives zeros and nulls', () => {
    const c = computeServerClock([], SID);
    expect(c.processesStarted).toBe(0);
    expect(c.accepted).toBe(0);
    expect(c.exitToAcceptLag).toEqual({ medianSeconds: null, maxSeconds: null });
    expect(c.processDuration).toEqual({ medianSeconds: null, maxSeconds: null, atMost2sCount: 0, total: 0 });
  });
});

describe('computeTranscriptCost', () => {
  const assistant = (id: string | undefined, usage: Record<string, number>) => ({
    type: 'assistant',
    message: { ...(id === undefined ? {} : { id }), usage },
  });

  it('dedups by message.id taking the last usage, ignores non-assistant, keeps id-less records apart', () => {
    const cost = computeTranscriptCost([
      assistant('m1', { input_tokens: 1, output_tokens: 1 }),
      assistant('m1', { input_tokens: 5, output_tokens: 5 }),
      assistant('m1', { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 30 }),
      { type: 'user', message: { id: 'm1', usage: { input_tokens: 999 } } },
      assistant(undefined, { input_tokens: 100 }),
      assistant(undefined, { input_tokens: 200 }),
    ]);
    expect(cost.status).toBe('ok');
    if (cost.status !== 'ok') return;
    expect(cost.calls).toBe(3);
    expect(cost.input).toBe(310);
    expect(cost.cacheRead).toBe(20);
    expect(cost.output).toBe(30);
  });

  it('prices a hand-computed row exactly', () => {
    const cost = computeTranscriptCost([
      assistant('m', {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ]);
    expect(cost.status).toBe('ok');
    if (cost.status !== 'ok') return;
    expect(cost.usd).toBeCloseTo(22.05, 10);
    const rows = formatReadinessRows({ ndjson: computeNdjsonMetrics([], SID), cost });
    expect(rows.find((r) => r.label === 'Cost, list-price equivalent, dedup')?.value).toBe('22.1 USD');
  });
});

describe('computeServerClock', () => {
  const sec = (s: number) => 1_000_000 + s * 1000;
  const started = (p: string, s: number) => ({ msg: 'Process started', sessionId: SID, processId: p, time: sec(s) });
  const exited = (p: string, s: number) => ({ msg: 'Process exited', processId: p, time: sec(s) });
  const timer = (s: number) => ({ msg: 'Timer created', sessionId: SID, intervalSeconds: 30, time: sec(s) });
  const refused = (s: number) => ({
    msg: 'create_timer refused: live run_process',
    sessionId: SID,
    time: sec(s),
  });

  it('classifies accepts and refusals against process liveness', () => {
    const c = computeServerClock(
      [
        started('p1', 0),
        timer(5), // while live
        exited('p1', 10),
        timer(11), // after the only exit, lag 1 s
        refused(5), // refused while live
        refused(20), // refused with none live
      ],
      SID,
    );
    expect(c.processesStarted).toBe(1);
    expect(c.processesExited).toBe(1);
    expect(c.accepted).toBe(2);
    expect(c.refused).toBe(2);
    expect(c.eligibleAttempts).toBe(4);
    expect(c.acceptedWhileLive).toBe(1);
    expect(c.acceptedAfterExit).toBe(1);
    expect(c.refusedWhileLive).toBe(1);
    expect(c.refusedNoneLive).toBe(1);
    expect(c.exitToAcceptLag).toEqual({ medianSeconds: 1, maxSeconds: 1 });
  });

  it('computes the median lag over three accepts', () => {
    const c = computeServerClock(
      [started('p', 0), exited('p', 1), timer(3), timer(5), timer(11)],
      SID,
    );
    expect(c.exitToAcceptLag).toEqual({ medianSeconds: 4, maxSeconds: 10 });
  });

  it('measures lag from the latest exit and ignores ineligible timers and other sessions', () => {
    const c = computeServerClock(
      [
        started('a', 0),
        started('b', 0),
        exited('a', 2),
        exited('b', 6),
        timer(9),
        { msg: 'Timer created', sessionId: SID, intervalSeconds: 30, backoffFactor: 2, time: sec(9) },
        { msg: 'Timer created', sessionId: SID, intervalSeconds: 300, time: sec(9) },
        { msg: 'Timer created', sessionId: 'other', intervalSeconds: 30, time: sec(9) },
        { msg: 'Process started', sessionId: 'other', processId: 'x', time: sec(0) },
      ],
      SID,
    );
    expect(c.accepted).toBe(1);
    expect(c.processesStarted).toBe(2);
    expect(c.exitToAcceptLag.medianSeconds).toBe(3);
  });

  it('counts durations at most 2 s inclusive', () => {
    const c = computeServerClock(
      [started('a', 0), exited('a', 2), started('b', 0), exited('b', 3), started('c', 0), exited('c', 1)],
      SID,
    );
    expect(c.processDuration.total).toBe(3);
    expect(c.processDuration.atMost2sCount).toBe(2);
    expect(c.processDuration.medianSeconds).toBe(2);
    expect(c.processDuration.maxSeconds).toBe(3);
  });
});

describe('formatReadinessRows vocabulary', () => {
  const base = {
    ndjson: computeNdjsonMetrics([], SID),
    cost: computeTranscriptCost([]),
  };

  it('pins the exact labels in order', () => {
    const labels = formatReadinessRows(base).map((r) => r.label);
    expect(labels).toEqual([
      'Timer calls create / delete / reset',
      'create_timer attempts under the refusal condition (interval < 120 s, no backoffFactor above 1)',
      '... refused by the server',
      '... accepted',
      'Self get_session_status',
      'list_processes',
      'Polling Cause A turns (>=10 polls in one turn) / their polls / Cause B polls',
      'Unique API calls (dedup by message.id)',
      'Cost, list-price equivalent, dedup',
      'Tool calls',
      'Turns (user-message)',
      'run_process calls',
      'run_process finished inline (exited: true)',
      'write_process_response',
      'write_memo / TodoWrite',
      'New substitute channel (create_conditional_wakeup / sleep run_process / send_session_message to self)',
      'context-usage n / first / max / mean',
      'Model',
    ]);
  });

  it('appends the server-clock rows only when a clock is given', () => {
    const rows = formatReadinessRows({ ...base, serverClock: computeServerClock([], SID) });
    expect(rows.slice(18).map((r) => r.label)).toEqual([
      'Processes finished within 2 s',
      'Exit notice lag: accepted timers after the last exit, median / max (s)',
      'Accepted while a process was live / after the last exit',
      'Refused while live / with none live',
    ]);
    expect(rows[18].value).toBe('n/a');
    expect(rows[19].value).toBe('n/a / n/a');
  });

  it('renders composite values', () => {
    const events = [
      call('t', `${PREFIX}create_timer`, { intervalSeconds: 30 }),
      call('t', `${PREFIX}delete_timer`),
      call('t', `${PREFIX}get_session_status`, { sessionId: SID }),
      call('t', `${PREFIX}get_session_status`, { sessionId: 'o' }),
      { type: 'context-usage', promptTokens: 10, model: 'm' },
    ];
    const rows = formatReadinessRows({ ...base, ndjson: computeNdjsonMetrics(events, SID) });
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get('Timer calls create / delete / reset')).toEqual({
      label: 'Timer calls create / delete / reset',
      value: '2 (1 / 1 / 0)',
      num: 2,
    });
    expect(byLabel.get('Self get_session_status')?.value).toBe('1 (2 total)');
    expect(byLabel.get('Model')?.value).toBe('m (1)');
  });
});

describe('formatDelta', () => {
  it('signs integers and uses one decimal otherwise', () => {
    expect(formatDelta(15, 3)).toBe('+12');
    expect(formatDelta(0, 3)).toBe('-3');
    expect(formatDelta(4, 4)).toBe('0');
    expect(formatDelta(10.5, 8)).toBe('+2.5');
    expect(formatDelta(8, 10.25)).toBe('-2.3');
  });
});

describe('refusal literal drift', () => {
  const SENTENCES = [
    'This process reports back on its own: its remaining output and its exit arrive as new turns, bounded by its timeoutSeconds.',
    'Do not poll get_session_status or list_processes, and do not create a timer to wait for it.',
    'End your turn; if the process is waiting for input, answer it with write_process_response instead of a timer.',
  ];
  const source = readFileSync(
    resolve(import.meta.dir, '../../../packages/server/src/services/process-output-router.ts'),
    'utf8',
  );

  it('finds every sentence in the server source', () => {
    for (const sentence of SENTENCES) expect(source).toContain(sentence);
  });

  it('is the three sentences joined with single spaces', () => {
    expect(TIMER_REFUSED_PROCESS_RUNNING_TEXT).toBe(SENTENCES.join(' '));
  });
});

describe('boundary values of each predicate', () => {
  it('a create_timer at exactly 120 s is not eligible, 119 s is', () => {
    const at120 = call('t', `${PREFIX}create_timer`, { intervalSeconds: 120 });
    const at119 = call('t', `${PREFIX}create_timer`, { intervalSeconds: 119 });
    const m = computeNdjsonMetrics([at120, at119], SID);
    expect(m.timers.create).toBe(2);
    expect(m.createTimerEligible).toBe(1);
  });

  it('9 polls in one turn are Cause B, 10 are Cause A', () => {
    const nine = Array.from({ length: 9 }, () => call('t9', `${PREFIX}list_processes`));
    const ten = Array.from({ length: 10 }, () => call('t10', `${PREFIX}list_processes`));
    const m = computeNdjsonMetrics([...nine, ...ten], SID);
    expect(m.causeATurns).toBe(1);
    expect(m.causeAPolls).toBe(10);
    expect(m.causeBPolls).toBe(9);
  });

  it('counts a turn only for user-message, not for assistant-message', () => {
    const m = computeNdjsonMetrics(
      [{ type: 'user-message' }, { type: 'assistant-message' }, { type: 'assistant-message' }],
      SID,
    );
    expect(m.turns).toBe(1);
  });

  it('only a command that STARTS with sleep is a sleep wait', () => {
    const m = computeNdjsonMetrics(
      [
        call('t', `${PREFIX}run_process`, { command: '  sleep 30' }),
        call('t', `${PREFIX}run_process`, { command: 'echo sleep' }),
      ],
      SID,
    );
    expect(m.substituteChannels.sleepRunProcess).toBe(1);
  });

  it('prices each token class at its own rate (four different quantities)', () => {
    const cost = computeTranscriptCost([
      {
        type: 'assistant',
        message: {
          id: 'm',
          usage: {
            input_tokens: 1_000_000,
            cache_creation_input_tokens: 2_000_000,
            cache_read_input_tokens: 3_000_000,
            output_tokens: 4_000_000,
          },
        },
      },
    ]);
    expect(cost.status).toBe('ok');
    if (cost.status !== 'ok') return;
    // 1*3 + 2*3.75 + 3*0.30 + 4*15 = 3 + 7.5 + 0.9 + 60
    expect(cost.usd).toBeCloseTo(71.4, 10);
  });

  describe('server clock', () => {
    const sec = (s: number) => 1_000_000 + s * 1000;
    const started = (p: string, s: number) => ({ msg: 'Process started', sessionId: SID, processId: p, time: sec(s) });
    const exited = (p: string, s: number) => ({ msg: 'Process exited', processId: p, time: sec(s) });
    const timer = (s: number) => ({ msg: 'Timer created', sessionId: SID, intervalSeconds: 30, time: sec(s) });

    it('an accept at the very millisecond of the exit is after the exit, not live', () => {
      const clock = computeServerClock([started('p', 0), exited('p', 5), timer(5)], SID);
      expect(clock.acceptedWhileLive).toBe(0);
      expect(clock.acceptedAfterExit).toBe(1);
      expect(clock.exitToAcceptLag.medianSeconds).toBe(0);
    });

    it('the median of an even count is the mean of the two middle values', () => {
      const clock = computeServerClock(
        [started('p', 0), exited('p', 1), timer(3), timer(5), timer(9), timer(13)],
        SID,
      );
      // lags 2, 4, 8, 12 -> median (4 + 8) / 2 = 6
      expect(clock.exitToAcceptLag.medianSeconds).toBe(6);
      expect(clock.exitToAcceptLag.maxSeconds).toBe(12);
    });
  });
});
