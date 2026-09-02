import { describe, it, expect } from 'bun:test';
import { resolveEffectiveContextWindow } from '../embedded-agent-context-window.js';

describe('resolveEffectiveContextWindow', () => {
  it('returns the definition\'s contextWindowTokens when set', () => {
    expect(resolveEffectiveContextWindow({ contextWindowTokens: 128_000 })).toBe(128_000);
  });

  it('returns undefined when the definition declares no window', () => {
    expect(resolveEffectiveContextWindow({ contextWindowTokens: undefined })).toBeUndefined();
  });

  it('returns undefined without throwing when the definition itself is undefined (deleted/dangling)', () => {
    expect(resolveEffectiveContextWindow(undefined)).toBeUndefined();
  });
});
