import { describe, expect, it } from 'bun:test';
import { toStatusChangeArgs } from '../status-mapping';

describe('toStatusChangeArgs', () => {
  it('passes connecting through with no exitInfo', () => {
    expect(toStatusChangeArgs({ status: 'connecting', exitInfo: null })).toEqual({
      status: 'connecting',
      exitInfo: undefined,
    });
  });

  it('passes connected through with no exitInfo', () => {
    expect(toStatusChangeArgs({ status: 'connected', exitInfo: null })).toEqual({
      status: 'connected',
      exitInfo: undefined,
    });
  });

  it('passes disconnected through with no exitInfo', () => {
    expect(toStatusChangeArgs({ status: 'disconnected', exitInfo: null })).toEqual({
      status: 'disconnected',
      exitInfo: undefined,
    });
  });

  it('forwards exitInfo for the exited status', () => {
    expect(
      toStatusChangeArgs({ status: 'exited', exitInfo: { code: 137, signal: 'SIGKILL' } }),
    ).toEqual({ status: 'exited', exitInfo: { code: 137, signal: 'SIGKILL' } });
  });

  it('normalizes a null exitInfo to undefined (callback contract, not null)', () => {
    const args = toStatusChangeArgs({ status: 'exited', exitInfo: null });
    expect(args.exitInfo).toBeUndefined();
    expect('exitInfo' in args).toBe(true); // key present, value undefined
  });
});
