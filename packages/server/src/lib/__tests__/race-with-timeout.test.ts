import { describe, it, expect, spyOn } from 'bun:test';
import { raceWithTimeout } from '../race-with-timeout.js';

describe('raceWithTimeout', () => {
  it('passes a resolved value through', async () => {
    await expect(raceWithTimeout(Promise.resolve('ok'), 1000, 'timed out')).resolves.toBe('ok');
  });

  it('passes a rejection from the raced promise through unchanged', async () => {
    const boom = new Error('boom');
    await expect(raceWithTimeout(Promise.reject(boom), 1000, 'timed out')).rejects.toBe(boom);
  });

  it('rejects with the given message when the promise does not settle in time', async () => {
    const never = new Promise<string>(() => {});
    await expect(raceWithTimeout(never, 20, 'History request timeout')).rejects.toThrow('History request timeout');
  });

  it('treats a zero timeout as an immediate timeout for a pending promise', async () => {
    const never = new Promise<string>(() => {});
    await expect(raceWithTimeout(never, 0, 'zero')).rejects.toThrow('zero');
  });

  // The helper's own timer is identified by the handle its setTimeout call
  // returned, so unrelated timers cleared elsewhere in the process during the
  // await cannot affect the assertion.
  async function timerClearedAfter(run: () => Promise<unknown>): Promise<{ created: unknown[]; cleared: unknown[] }> {
    const created: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const handle = realSet(...args);
      created.push(handle);
      return handle;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      return realClear(handle);
    }) as typeof clearTimeout);
    try {
      await run();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
    return { created, cleared };
  }

  it('clears its timer when the promise resolves first', async () => {
    const { created, cleared } = await timerClearedAfter(() => raceWithTimeout(Promise.resolve(1), 60_000, 'timed out'));
    expect(created).toHaveLength(1);
    expect(cleared).toContain(created[0]);
  });

  it('clears its timer when the promise rejects first', async () => {
    const { created, cleared } = await timerClearedAfter(() =>
      raceWithTimeout(Promise.reject(new Error('x')), 60_000, 'timed out').catch(() => {}),
    );
    expect(created).toHaveLength(1);
    expect(cleared).toContain(created[0]);
  });

  it('clears its timer after a timeout too (no leftover handle)', async () => {
    const { created, cleared } = await timerClearedAfter(() =>
      raceWithTimeout(new Promise<never>(() => {}), 10, 'timed out').catch(() => {}),
    );
    expect(created).toHaveLength(1);
    expect(cleared).toContain(created[0]);
  });
});
