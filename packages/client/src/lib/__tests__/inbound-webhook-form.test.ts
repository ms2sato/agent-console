import { describe, it, expect } from 'bun:test';
import { validateInstructionText, validateLabel } from '../inbound-webhook-form';

describe('validateInstructionText', () => {
  it('accepts a normal single line', () => {
    expect(validateInstructionText('Triage this message')).toBeNull();
  });

  it('accepts exactly 300 characters and rejects 301', () => {
    expect(validateInstructionText('a'.repeat(300))).toBeNull();
    expect(validateInstructionText('a'.repeat(301))).toMatch(/at most 300/);
  });

  it('rejects LF, CR and a trailing line break', () => {
    expect(validateInstructionText('a\nb')).toMatch(/single line/);
    expect(validateInstructionText('a\rb')).toMatch(/single line/);
    expect(validateInstructionText('a\n')).toMatch(/single line/);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(validateInstructionText('')).toMatch(/required/);
    expect(validateInstructionText('   ')).toMatch(/required/);
  });
});

describe('validateLabel', () => {
  it('accepts 1 and 100 characters, rejects empty, blank and 101', () => {
    expect(validateLabel('a')).toBeNull();
    expect(validateLabel('a'.repeat(100))).toBeNull();
    expect(validateLabel('')).toMatch(/required/);
    expect(validateLabel('   ')).toMatch(/required/);
    expect(validateLabel('a'.repeat(101))).toMatch(/at most 100/);
  });

  it('measures the trimmed value', () => {
    expect(validateLabel(` ${'a'.repeat(100)} `)).toBeNull();
  });
});
