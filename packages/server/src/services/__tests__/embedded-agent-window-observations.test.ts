import { describe, it, expect } from 'bun:test';
import { WindowObservationRegister } from '../embedded-agent-window-observations.js';

describe('WindowObservationRegister', () => {
  it('starts empty for any definition', () => {
    expect(new WindowObservationRegister().get('def-1')).toBeUndefined();
  });

  it('records a provider-stated limit and reports a change', () => {
    const register = new WindowObservationRegister();

    expect(register.record('def-1', { kind: 'providerStated', tokens: 200000 }, 't1')).toBe(true);

    expect(register.get('def-1')).toEqual({ providerStated: { tokens: 200000, observedAt: 't1' } });
  });

  it('keeps the latest provider-stated reading: a different number overwrites, the same number changes nothing', () => {
    const register = new WindowObservationRegister();
    register.record('def-1', { kind: 'providerStated', tokens: 200000 }, 't1');

    expect(register.record('def-1', { kind: 'providerStated', tokens: 200000 }, 't2')).toBe(false);
    expect(register.get('def-1')?.providerStated).toEqual({ tokens: 200000, observedAt: 't1' });

    expect(register.record('def-1', { kind: 'providerStated', tokens: 128000 }, 't3')).toBe(true);
    expect(register.get('def-1')?.providerStated).toEqual({ tokens: 128000, observedAt: 't3' });
  });

  it('records an apparent clamp once; a repeated clamp reading changes nothing visible', () => {
    const register = new WindowObservationRegister();

    expect(register.record('def-1', { kind: 'apparentClamp' }, 't1')).toBe(true);
    expect(register.record('def-1', { kind: 'apparentClamp' }, 't2')).toBe(false);

    expect(register.get('def-1')).toEqual({ apparentClamp: { observedAt: 't1' } });
  });

  it('never merges the two kinds: each is kept and neither overwrites the other', () => {
    const register = new WindowObservationRegister();
    register.record('def-1', { kind: 'apparentClamp' }, 't1');
    register.record('def-1', { kind: 'providerStated', tokens: 100 }, 't2');
    register.record('def-1', { kind: 'apparentClamp' }, 't3');

    expect(register.get('def-1')).toEqual({
      apparentClamp: { observedAt: 't1' },
      providerStated: { tokens: 100, observedAt: 't2' },
    });
  });

  it('keeps definitions independent', () => {
    const register = new WindowObservationRegister();
    register.record('def-1', { kind: 'apparentClamp' }, 't1');

    expect(register.get('def-2')).toBeUndefined();
  });

  it('clear drops a definition\'s observations and reports whether there were any', () => {
    const register = new WindowObservationRegister();
    register.record('def-1', { kind: 'apparentClamp' }, 't1');

    expect(register.clear('def-1')).toBe(true);
    expect(register.get('def-1')).toBeUndefined();
    expect(register.clear('def-1')).toBe(false);
    expect(register.clear('never-seen')).toBe(false);
  });
});
