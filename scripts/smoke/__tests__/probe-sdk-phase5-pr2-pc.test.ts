/**
 * `parseCliArgs` for `scripts/smoke/probe-sdk-phase5-pr2-pc.ts`.
 *
 * The probe itself is billable (non-elevated arm) or needs elevation
 * privilege (elevated arm), so its measurement is never run here. This pins
 * only the argument-parsing decision: which argv shapes select which arm,
 * and which are rejected as a usage error.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { parseCliArgs } from '../probe-sdk-phase5-pr2-pc.js';

/** Thrown by the mocked `process.exit` so a rejection path stops control flow the same way a real exit would, instead of falling through past it. */
class ProcessExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code}) called`);
  }
}

function withMockedExit(fn: () => void): { exitCalls: Array<number | undefined>; errorLines: string[] } {
  const exitCalls: Array<number | undefined> = [];
  const errorLines: string[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code);
    throw new ProcessExitCalled(code);
  }) as never);
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
  try {
    fn();
  } catch (err) {
    if (!(err instanceof ProcessExitCalled)) throw err;
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { exitCalls, errorLines };
}

describe('probe-sdk-phase5-pr2-pc smoke: parseCliArgs', () => {
  it('returns non-elevated mode for empty argv', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'non-elevated' });
  });

  it('returns elevated mode for --elevated <user>', () => {
    expect(parseCliArgs(['--elevated', 'alice'])).toEqual({ mode: 'elevated', targetUsername: 'alice' });
  });

  it('strips a leading -- separator', () => {
    expect(parseCliArgs(['--', '--elevated', 'alice'])).toEqual({ mode: 'elevated', targetUsername: 'alice' });
  });

  it('rejects --elevated with no user (usage, exit 2)', () => {
    const { exitCalls, errorLines } = withMockedExit(() => {
      parseCliArgs(['--elevated']);
    });
    expect(exitCalls).toEqual([2]);
    expect(errorLines.some((line) => line.includes('usage:'))).toBe(true);
  });

  it('rejects a trailing argument after --elevated <user> (usage, exit 2)', () => {
    const { exitCalls, errorLines } = withMockedExit(() => {
      parseCliArgs(['--elevated', 'alice', 'garbage']);
    });
    expect(exitCalls).toEqual([2]);
    expect(errorLines.some((line) => line.includes('usage:'))).toBe(true);
  });

  it('rejects an unrecognized first argument (usage, exit 2)', () => {
    const { exitCalls } = withMockedExit(() => {
      parseCliArgs(['--bogus']);
    });
    expect(exitCalls).toEqual([2]);
  });
});
