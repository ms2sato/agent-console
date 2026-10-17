import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import {
  getOrCreateTerminal,
  _resetTerminals,
  _whenIdle,
  _setClockForTest,
  CLIPBOARD_INTENT_WINDOW_MS,
  type ClipboardWriteEvent,
} from '../terminal-store';

// OSC 52 clipboard (design doc "OSC 52 clipboard"): the live terminal reports clipboard
// writes, never answers reads, ignores replayed bytes and carries an intent gate.

const EPOCH = 1000;
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const osc52 = (payload: string, terminator = '\x07') => `\x1b]52;c;${payload}${terminator}`;

function open() {
  const instance = getOrCreateTerminal('s-clip', 'w-clip');
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('no ws');
  ws.simulateOpen();
  const events: ClipboardWriteEvent[] = [];
  instance.onClipboardWrite((e) => events.push(e));
  return { instance, ws, events };
}

function history(ws: MockWebSocket, data: string, epoch = EPOCH) {
  ws.simulateMessage(JSON.stringify({ type: 'history', data, offset: data.length, startOffset: 0, epoch }));
}

let nextOffset = 0;
async function output(ws: MockWebSocket, data: string, epoch = EPOCH) {
  nextOffset += data.length;
  ws.simulateMessage(JSON.stringify({ type: 'output', data, offset: nextOffset, epoch }));
  await _whenIdle();
}

describe('terminal-store OSC 52 clipboard', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    _resetTerminals();
    restoreWebSocket = installMockWebSocket();
    nextOffset = 0;
  });

  afterEach(() => {
    _setClockForTest(null);
    _resetTerminals();
    restoreWebSocket();
  });

  it('extracts the decoded payload from a BEL-terminated and an ST-terminated sequence', async () => {
    const { ws, events } = open();
    history(ws, '');
    await output(ws, osc52(b64('hello')));
    await output(ws, osc52(b64('wörld'), '\x1b\\'));
    expect(events.map((e) => e.text)).toEqual(['hello', 'wörld']);
  });

  it('never answers a read request and ignores an empty payload', async () => {
    const { ws, events } = open();
    history(ws, '');
    const sentBefore = ws.send.mock.calls.length;
    await output(ws, osc52('?'));
    await output(ws, osc52(''));
    expect(events).toEqual([]);
    // Nothing was written back to the worker (no clipboard report, no input).
    expect(ws.send.mock.calls.length).toBe(sentBefore);
  });

  it('ignores an oversize payload and an undecodable one', async () => {
    const { ws, events } = open();
    history(ws, '');
    await output(ws, osc52(b64('a'.repeat(64 * 1024 + 1))));
    await output(ws, osc52('!!!not base64!!!'));
    await output(ws, osc52(btoa('\xff\xfe')));
    expect(events).toEqual([]);
    await output(ws, osc52(b64('a'.repeat(64 * 1024))));
    expect(events).toHaveLength(1);
  });

  it('is suppressed while the initial history is applied, then live output fires again', async () => {
    const { ws, events } = open();
    // Large enough to be written in several pieces: every piece is covered.
    const filler = 'line of old output\r\n'.repeat(1000);
    history(ws, filler + osc52(b64('OLD')) + filler);
    await _whenIdle();
    expect(events).toEqual([]);
    nextOffset = 100_000;
    await output(ws, osc52(b64('NEW')));
    expect(events.map((e) => e.text)).toEqual(['NEW']);
  });

  it('is suppressed during a resync replay (queued output flushed after the fresh history)', async () => {
    const { ws, events } = open();
    history(ws, 'before\r\n');
    await _whenIdle();
    // A new epoch starts a resync; output arriving meanwhile is queued, then replayed.
    ws.simulateMessage(JSON.stringify({ type: 'output', data: osc52(b64('QUEUED')), offset: 50, epoch: EPOCH + 1 }));
    await _whenIdle();
    ws.simulateMessage(JSON.stringify({ type: 'history', data: 'fresh\r\n', offset: 10, startOffset: 0, epoch: EPOCH + 1 }));
    await _whenIdle();
    expect(events).toEqual([]);
    nextOffset = 200;
    await output(ws, osc52(b64('LIVE')), EPOCH + 1);
    expect(events.map((e) => e.text)).toEqual(['LIVE']);
  });

  it('reports recentInput true at exactly the window and false one millisecond later', async () => {
    let now = 1_000;
    _setClockForTest(() => now);
    const { instance, ws, events } = open();
    history(ws, '');
    instance.sendInput('/copy\r');
    now = 1_000 + CLIPBOARD_INTENT_WINDOW_MS;
    await output(ws, osc52(b64('inside')));
    now = 1_000 + CLIPBOARD_INTENT_WINDOW_MS + 1;
    await output(ws, osc52(b64('outside')));
    expect(CLIPBOARD_INTENT_WINDOW_MS).toBe(5000);
    expect(events.map((e) => [e.text, e.recentInput, e.atMs])).toEqual([
      ['inside', true, 6_000],
      ['outside', false, 6_001],
    ]);
  });

  it('reports recentInput false when this client never sent input', async () => {
    _setClockForTest(() => 10);
    const { ws, events } = open();
    history(ws, '');
    await output(ws, osc52(b64('someone else typed')));
    expect(events.map((e) => e.recentInput)).toEqual([false]);
  });

  it('a paged range chunk containing OSC 52 emits nothing (replay terminals register no handler)', async () => {
    const { instance, ws, events } = open();
    ws.simulateMessage(JSON.stringify({ type: 'history', data: 'live\r\n', offset: 100, startOffset: 50, epoch: EPOCH }));
    await _whenIdle();
    instance.requestOlderHistory();
    const req = [...ws.send.mock.calls].map((c) => JSON.parse(c[0])).reverse().find((m) => m.type === 'request-history-range');
    ws.simulateMessage(
      JSON.stringify({ type: 'history-range', requestId: req.requestId, data: `old\r\n${osc52(b64('ARCHIVED'))}`, startOffset: 10, endOffset: 50, hasMore: true, epoch: EPOCH }),
    );
    await _whenIdle();
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual([]);
    const source = readFileSync(new URL('../history-replay.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('registerOscHandler');
  });
});
