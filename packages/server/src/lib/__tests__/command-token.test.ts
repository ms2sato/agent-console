import { describe, it, expect } from 'bun:test';
import { extractCommandToken } from '../command-token.js';

describe('extractCommandToken', () => {
  it('extracts the program name from a plain template', () => {
    expect(extractCommandToken('claude --dangerously-skip-permissions')).toBe('claude');
  });

  it('skips a single VAR=value assignment prefix', () => {
    expect(extractCommandToken('FOO=bar claude --flag')).toBe('claude');
  });

  it('skips multiple assignment prefixes', () => {
    expect(extractCommandToken('A=1 B=2 mycmd --x')).toBe('mycmd');
  });

  it('falls back to the full string when every token is an assignment', () => {
    expect(extractCommandToken('FOO=bar BAZ=qux')).toBe('FOO=bar BAZ=qux');
  });

  it('falls back to the full string when the candidate still has an unexpanded placeholder', () => {
    expect(extractCommandToken('{{cmd}} --flag')).toBe('{{cmd}} --flag');
  });

  it('returns an empty string for empty input', () => {
    expect(extractCommandToken('')).toBe('');
  });

  it('falls back to the original (unmodified) input for whitespace-only input', () => {
    expect(extractCommandToken('   ')).toBe('   ');
  });
});
