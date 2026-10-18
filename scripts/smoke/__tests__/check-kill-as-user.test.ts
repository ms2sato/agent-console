import { describe, it, expect } from 'bun:test';
import { parseArgs, terminationAccepted } from '../check-kill-as-user.js';

describe('check-kill-as-user smoke: argv parsing', () => {
  it('takes the single positional as the target user and leaves --require-reaped off by default', () => {
    expect(parseArgs(['alice'])).toEqual({ targetUsername: 'alice', requireReaped: false });
  });

  it('turns --require-reaped on wherever it appears', () => {
    expect(parseArgs(['--require-reaped', 'alice'])).toEqual({ targetUsername: 'alice', requireReaped: true });
    expect(parseArgs(['alice', '--require-reaped'])).toEqual({ targetUsername: 'alice', requireReaped: true });
  });

  it('reports no target user when none is given', () => {
    expect(parseArgs([]).targetUsername).toBeUndefined();
    expect(parseArgs(['--require-reaped']).targetUsername).toBeUndefined();
  });
});

describe('check-kill-as-user smoke: termination acceptance', () => {
  it('accepts ESRCH with or without --require-reaped', () => {
    expect(terminationAccepted({ gone: true, how: 'esrch' }, false)).toBe(true);
    expect(terminationAccepted({ gone: true, how: 'esrch' }, true)).toBe(true);
  });

  it('accepts a zombie only when reaping is not required', () => {
    expect(terminationAccepted({ gone: true, how: 'zombie' }, false)).toBe(true);
    expect(terminationAccepted({ gone: true, how: 'zombie' }, true)).toBe(false);
  });

  it('never accepts a process that is still alive', () => {
    expect(terminationAccepted({ gone: false, state: 'S' }, false)).toBe(false);
    expect(terminationAccepted({ gone: false, state: 'S' }, true)).toBe(false);
  });
});
