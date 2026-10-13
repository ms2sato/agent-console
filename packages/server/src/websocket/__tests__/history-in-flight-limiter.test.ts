import { describe, it, expect } from 'bun:test';
import { HistoryInFlightLimiter, reportHistoryOverCap } from '../history-in-flight-limiter.js';

describe('HistoryInFlightLimiter', () => {
  it('with cap 1 (the minimum) refuses a second acquire until release', () => {
    const limiter = new HistoryInFlightLimiter(1);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('with cap 4 grants four and refuses the fifth', () => {
    const limiter = new HistoryInFlightLimiter(4);
    expect([1, 2, 3, 4].map(() => limiter.tryAcquire())).toEqual([true, true, true, true]);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.inFlight).toBe(4);
  });

  it('tracks inFlight through acquire and release', () => {
    const limiter = new HistoryInFlightLimiter(3);
    expect(limiter.inFlight).toBe(0);
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.inFlight).toBe(2);
    limiter.release();
    expect(limiter.inFlight).toBe(1);
  });

  it('never goes below zero on a surplus release, and a surplus release grants no extra capacity', () => {
    const limiter = new HistoryInFlightLimiter(1);
    limiter.release();
    limiter.release();
    expect(limiter.inFlight).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('counts only refused acquires as rejections', () => {
    const limiter = new HistoryInFlightLimiter(1);
    limiter.tryAcquire();
    expect(limiter.rejectedCount).toBe(0);
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.rejectedCount).toBe(2);
  });
});

describe('reportHistoryOverCap', () => {
  function makeLog() {
    const calls: Array<{ level: 'warn' | 'debug'; fields: Record<string, unknown> }> = [];
    return {
      calls,
      log: {
        warn: (fields: Record<string, unknown>) => { calls.push({ level: 'warn', fields }); },
        debug: (fields: Record<string, unknown>) => { calls.push({ level: 'debug', fields }); },
      },
    };
  }

  it('returns the cap message naming the max', () => {
    const limiter = new HistoryInFlightLimiter(2);
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    const { log } = makeLog();
    expect(reportHistoryOverCap(limiter, { sessionId: 's', workerId: 'w', type: 'request-history' }, log as never)).toBe(
      'Too many concurrent history requests on this connection (max 2); retry after the pending ones complete.',
    );
  });

  it('warns on the first rejection of a connection and only debugs the rest', () => {
    const limiter = new HistoryInFlightLimiter(1);
    limiter.tryAcquire();
    const { calls, log } = makeLog();
    for (let i = 0; i < 3; i++) {
      limiter.tryAcquire();
      reportHistoryOverCap(limiter, { sessionId: 's', workerId: 'w', type: 'request-history' }, log as never);
    }
    expect(calls.map((c) => c.level)).toEqual(['warn', 'debug', 'debug']);
    expect(calls[0].fields).toMatchObject({ sessionId: 's', workerId: 'w', type: 'request-history', inFlight: 1, max: 1 });
  });
});
