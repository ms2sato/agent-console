import { describe, it, expect } from 'bun:test';
import { socketKey, liveReadyState } from '../socket-key.js';
import { anotherContextFor, asWSContext } from './ws-test-helpers.js';

describe('socketKey', () => {
  it('is the same for every context of one connection and different between connections', () => {
    const a = asWSContext({ send: () => {} });
    const b = asWSContext({ send: () => {} });
    expect(socketKey(anotherContextFor(a))).toBe(socketKey(a));
    expect(socketKey(a)).not.toBe(socketKey(b));
  });

  it('falls back to the context itself when it has no object raw', () => {
    const bare = { send: () => {}, raw: undefined } as unknown as Parameters<typeof socketKey>[0];
    expect(socketKey(bare)).toBe(bare);
  });
});

describe('liveReadyState', () => {
  it('reads raw.readyState in preference to the snapshot on the context', () => {
    const ws = asWSContext({ readyState: 1, raw: { readyState: 3 } });
    expect(liveReadyState(ws)).toBe(3);
  });

  it('falls back to the context readyState, then to undefined', () => {
    expect(liveReadyState(asWSContext({ readyState: 1, raw: {} }))).toBe(1);
    expect(liveReadyState(asWSContext({ raw: {} }))).toBeUndefined();
  });
});
