/**
 * Transcript Restore, R1 (the local half of #1273): the interrupted-turn
 * detector, pinned against REAL persisted streams.
 *
 * The four `G1_*` fixtures below are verbatim captures from the G1 gate on
 * unmodified `main` @5feca85b -- a real `claude-sdk` worker on a real dev
 * instance, killed four different ways, with a WebSocket client recording
 * every frame. They are preserved here rather than hand-written because the
 * detector's whole job is to classify what real deaths actually leave behind,
 * and a hand-written fixture can only ever restate what its author already
 * believed. Two of them already caught a wrong rule during design (see the
 * `exited` and `turn-error` cases below).
 *
 * The rule's single writer is docs/design/embedded-agent-sdk-engine.md
 * Appendix A.3.
 */
import { describe, it, expect } from 'bun:test';
import { findInterruptedTurnId } from '../embedded-agent-worker-service.js';

/**
 * G1, idle kill: a completed turn, then the whole worker tree terminated
 * while nothing was in flight. The server observed the exit and appended
 * `exited`.
 *
 * This is the fixture that disproves including `exited` in the terminal set
 * -- it is present here, and this stream is NOT interrupted.
 */
const G1_IDLE_KILL = [
  '{"v":1,"type":"ready"}',
  '{"v":1,"type":"user-message","id":"3f57e92d-070d-4202-99b0-9e12f403ed47","text":"Remember this secret word: WOMBAT-3312. Reply with only OK."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"sdk-session-id","sdkSessionId":"57ba9d18-7a64-4972-9464-bcbd0226f342"}',
  '{"v":1,"type":"assistant-message","turnId":"3f57e92d-070d-4202-99b0-9e12f403ed47","text":"OK"}',
  '{"v":1,"type":"context-usage","promptTokens":16886,"estimated":false}',
  '{"v":1,"type":"state","state":"idle"}',
  '{"v":1,"type":"exited","code":137}',
].join('\n');

/**
 * G1, mid-turn kill of the `sh` wrapper: the harness outlived the SDK child
 * by ~270 ms and got a `turn-error` out before dying. The turn ended badly,
 * but it ended -- and the user already sees the error.
 */
const G1_MIDTURN_KILL_WITH_TURN_ERROR = [
  '{"v":1,"type":"ready"}',
  '{"v":1,"type":"user-message","id":"5252cf2b-32d0-4625-a9f2-20942d8fac42","text":"Remember this secret word: WOMBAT-3312. Reply with only OK."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"assistant-message","turnId":"5252cf2b-32d0-4625-a9f2-20942d8fac42","text":"OK"}',
  '{"v":1,"type":"state","state":"idle"}',
  '{"v":1,"type":"user-message","id":"052699ab-81e8-4310-b5fc-9f76cd151bfa","text":"Count slowly from 1 to 40, one number per line, with a short sentence about each number."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"assistant-delta","turnId":"052699ab-81e8-4310-b5fc-9f76cd151bfa","text":"1. One is the beginning of any count."}',
  '{"v":1,"type":"context-usage","promptTokens":16960,"estimated":false}',
  '{"v":1,"type":"turn-error","turnId":"052699ab-81e8-4310-b5fc-9f76cd151bfa","message":"SDK turn failed: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"}',
  '{"v":1,"type":"state","state":"idle"}',
  '{"v":1,"type":"exited","code":137}',
].join('\n');

/**
 * G1, mid-turn kill of the harness itself: 7 ms to `exited`, with no chance
 * to emit anything. The stream stops on a half-finished delta.
 *
 * THIS is the shape the detector exists for, and the one an
 * `exited`-is-terminal rule would have missed.
 */
const G1_MIDTURN_KILL_NO_TERMINAL = [
  '{"v":1,"type":"ready"}',
  '{"v":1,"type":"user-message","id":"63a39f07-8157-4d44-901b-6b9ec784159b","text":"Remember this secret word: WOMBAT-3312. Reply with only OK."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"assistant-message","turnId":"63a39f07-8157-4d44-901b-6b9ec784159b","text":"OK"}',
  '{"v":1,"type":"state","state":"idle"}',
  '{"v":1,"type":"user-message","id":"5ab99d8e-dd70-41ba-9eb5-3aea9f792a78","text":"Count slowly from 1 to 40, one number per line, with a short sentence about each number."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"assistant-delta","turnId":"5ab99d8e-dd70-41ba-9eb5-3aea9f792a78","text":"25. Twenty-five - a quarter century"}',
  '{"v":1,"type":"exited","code":137}',
].join('\n');

/**
 * G1, the `claude` grandchild killed alone (Issue #1414): the harness never
 * exits, so there is no `exited` row at all, and the user's next message is
 * answered with a `fatal` that carries no `state`. The transcript ends on a
 * user message nothing ever answered.
 *
 * `fatal` is deliberately NOT terminal: it says the process is broken, not
 * that this turn was answered.
 */
const G1_GRANDCHILD_KILL_WEDGED = [
  '{"v":1,"type":"ready"}',
  '{"v":1,"type":"user-message","id":"ea48340b-7666-49a0-ad75-2e3462b44a3f","text":"Remember this secret word: WOMBAT-3312. Reply with only OK."}',
  '{"v":1,"type":"state","state":"active"}',
  '{"v":1,"type":"assistant-message","turnId":"ea48340b-7666-49a0-ad75-2e3462b44a3f","text":"OK"}',
  '{"v":1,"type":"state","state":"idle"}',
  '{"v":1,"type":"fatal","message":"SDK transport error: Claude Code process terminated by signal SIGKILL"}',
  '{"v":1,"type":"user-message","id":"7d5603db-f39f-4bfe-865a-541d27e66877","text":"What was the secret word I told you? Reply with only the word."}',
  '{"v":1,"type":"fatal","message":"SDK engine session already terminated; cannot start a new turn"}',
].join('\n');

describe('findInterruptedTurnId — real G1 streams', () => {
  it('does not flag an idle kill, even though `exited` follows the last turn', () => {
    // The `exited`-is-terminal rule would have agreed here by accident; what
    // makes this fixture load-bearing is that it agrees for the RIGHT reason
    // -- the turn reached `state: idle` on its own.
    expect(findInterruptedTurnId(G1_IDLE_KILL)).toBeNull();
  });

  it('does not flag a turn that ended in a turn-error', () => {
    expect(findInterruptedTurnId(G1_MIDTURN_KILL_WITH_TURN_ERROR)).toBeNull();
  });

  it('flags a turn the harness died in the middle of', () => {
    expect(findInterruptedTurnId(G1_MIDTURN_KILL_NO_TERMINAL)).toBe('5ab99d8e-dd70-41ba-9eb5-3aea9f792a78');
  });

  it('flags the swallowed message of a wedged worker, where no `exited` was ever written', () => {
    expect(findInterruptedTurnId(G1_GRANDCHILD_KILL_WEDGED)).toBe('7d5603db-f39f-4bfe-865a-541d27e66877');
  });
});

describe('findInterruptedTurnId — the terminal set', () => {
  const userMessage = '{"v":1,"type":"user-message","id":"u1","text":"hi"}';

  it('treats `state: idle` as terminal', () => {
    expect(findInterruptedTurnId([userMessage, '{"v":1,"type":"state","state":"idle"}'].join('\n'))).toBeNull();
  });

  it('treats `turn-error` as terminal even with no `idle` behind it', () => {
    // Not redundant with `idle`, which is the whole reason it is in the set:
    // sdk-engine's handleResult emits `turn-error` and then HOLDS the turn
    // open, without an `idle`, when a Compact was booked during it. A death
    // inside that window is an errored turn, not an interrupted one.
    expect(findInterruptedTurnId([userMessage, '{"v":1,"type":"turn-error","turnId":"u1","message":"boom"}'].join('\n'))).toBeNull();
  });

  it('does NOT treat `state: active` as terminal', () => {
    expect(findInterruptedTurnId([userMessage, '{"v":1,"type":"state","state":"active"}'].join('\n'))).toBe('u1');
  });

  it('does NOT treat `exited` as terminal', () => {
    // The exclusion that makes the detector useful at all: the server appends
    // `exited` on every exit it observes, so counting it would leave this
    // firing only when the server itself died -- never for a worker death the
    // server did observe, which is the common case and the one a deliberate
    // eviction (#1412) creates by design.
    expect(findInterruptedTurnId([userMessage, '{"v":1,"type":"exited","code":137}'].join('\n'))).toBe('u1');
  });

  it('does NOT treat `assistant-message` as terminal', () => {
    // Tempting, and wrong: the openai-api engine emits one per TOOL ITERATION,
    // so a death after iteration 1 of a multi-iteration turn would be cleared
    // by a rule that counted it.
    expect(
      findInterruptedTurnId([userMessage, '{"v":1,"type":"assistant-message","turnId":"u1","text":"partial"}'].join('\n')),
    ).toBe('u1');
  });

  it('does NOT treat `fatal` as terminal', () => {
    expect(findInterruptedTurnId([userMessage, '{"v":1,"type":"fatal","message":"dead"}'].join('\n'))).toBe('u1');
  });
});

describe('findInterruptedTurnId — vacuous and adversarial inputs', () => {
  // Vacuity is this codebase's recorded blind spot, and this predicate is
  // exactly the shape that hides it: "no terminal event after the last
  // user-message" reads as TRUE when there is no last user-message.
  it('reports null for an empty stream', () => {
    expect(findInterruptedTurnId('')).toBeNull();
  });

  it('reports null for a stream with no user-message at all', () => {
    expect(findInterruptedTurnId('{"v":1,"type":"ready"}\n{"v":1,"type":"exited","code":0}')).toBeNull();
  });

  it('reports null immediately after a completed turn boundary', () => {
    expect(
      findInterruptedTurnId(
        ['{"v":1,"type":"user-message","id":"u1","text":"hi"}', '{"v":1,"type":"state","state":"idle"}'].join('\n'),
      ),
    ).toBeNull();
  });

  it('reports only the LAST user-message when several turns ran', () => {
    // An earlier user-message is closed by the fact that a later turn started
    // at all; only the last one can still be open.
    expect(
      findInterruptedTurnId(
        [
          '{"v":1,"type":"user-message","id":"u1","text":"first"}',
          '{"v":1,"type":"state","state":"idle"}',
          '{"v":1,"type":"user-message","id":"u2","text":"second"}',
        ].join('\n'),
      ),
    ).toBe('u2');
  });

  it('survives a torn trailing line', () => {
    // The realistic corruption: the previous incarnation was killed partway
    // through writing a line. A detector that threw here would take
    // activation down over a cosmetic marker.
    expect(
      findInterruptedTurnId(
        ['{"v":1,"type":"user-message","id":"u1","text":"hi"}', '{"v":1,"type":"sta'].join('\n'),
      ),
    ).toBe('u1');
  });

  it('ignores a user-message with no usable id rather than emitting a marker for it', () => {
    expect(findInterruptedTurnId('{"v":1,"type":"user-message","text":"no id"}')).toBeNull();
  });

  it('tolerates blank lines', () => {
    expect(findInterruptedTurnId('\n\n{"v":1,"type":"user-message","id":"u1","text":"hi"}\n\n')).toBe('u1');
  });
});
