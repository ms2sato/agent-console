import { describe, it, expect } from 'bun:test';
import { raceWithTimeout } from '../race-with-timeout.js';
import { timerClearedAfter } from '../../__tests__/utils/timer-capture.js';

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

  describe('with an error factory', () => {
    class TypedTimeoutError extends Error {}

    it('rejects with the factory\'s own instance on timeout', async () => {
      const made = new TypedTimeoutError('typed timeout');
      const never = new Promise<string>(() => {});
      await expect(raceWithTimeout(never, 10, () => made)).rejects.toBe(made);
    });

    it('does not call the factory when the promise wins', async () => {
      let calls = 0;
      await expect(
        raceWithTimeout(Promise.resolve('ok'), 1000, () => {
          calls += 1;
          return new Error('unused');
        }),
      ).resolves.toBe('ok');
      expect(calls).toBe(0);
    });

    it('a string still rejects with a plain Error carrying that message', async () => {
      const never = new Promise<string>(() => {});
      const err = await raceWithTimeout(never, 10, 'plain').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypedTimeoutError);
      expect(err.message).toBe('plain');
    });

    it('clears its timer when the promise resolves first', async () => {
      const { created, cleared } = await timerClearedAfter(() =>
        raceWithTimeout(Promise.resolve(1), 60_000, () => new Error('x')),
      );
      expect(created).toHaveLength(1);
      expect(cleared).toContain(created[0]);
    });

    it('clears its timer when the promise rejects first', async () => {
      const { created, cleared } = await timerClearedAfter(() =>
        raceWithTimeout(Promise.reject(new Error('x')), 60_000, () => new Error('t')).catch(() => {}),
      );
      expect(created).toHaveLength(1);
      expect(cleared).toContain(created[0]);
    });

    it('clears its timer after a timeout too', async () => {
      const { created, cleared } = await timerClearedAfter(() =>
        raceWithTimeout(new Promise<never>(() => {}), 10, () => new Error('t')).catch(() => {}),
      );
      expect(created).toHaveLength(1);
      expect(cleared).toContain(created[0]);
    });
  });
});
