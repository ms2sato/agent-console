import { describe, expect, test } from 'bun:test';
import { truncate, extractLinkedIssueNumber } from '../brew-invariants.js';

describe('truncate', () => {
  test('returns input unchanged when under the line limit', () => {
    const input = 'line 1\nline 2\nline 3';
    expect(truncate(input, 10)).toBe(input);
  });

  test('returns input unchanged at exactly the line limit', () => {
    const input = 'a\nb\nc';
    expect(truncate(input, 3)).toBe(input);
  });

  test('truncates content above the limit and appends a marker', () => {
    const input = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = truncate(input, 5);
    const outLines = out.split('\n');
    expect(outLines[0]).toBe('line 1');
    expect(outLines[4]).toBe('line 5');
    expect(out).toContain('15 more lines truncated');
  });

  test('handles empty input', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('extractLinkedIssueNumber', () => {
  test('extracts number from "closes #NNN"', () => {
    expect(extractLinkedIssueNumber('This PR closes #634.')).toBe('634');
  });

  test('extracts from "fixes #N" and "resolves #N"', () => {
    expect(extractLinkedIssueNumber('Fixes #1')).toBe('1');
    expect(extractLinkedIssueNumber('resolves #42')).toBe('42');
  });

  test('handles past tense variants (closed / fixed / resolved)', () => {
    expect(extractLinkedIssueNumber('closed #10')).toBe('10');
    expect(extractLinkedIssueNumber('fixed #11')).toBe('11');
    expect(extractLinkedIssueNumber('resolved #12')).toBe('12');
  });

  test('returns null when no issue reference present', () => {
    expect(extractLinkedIssueNumber('Refactoring only, no issue link.')).toBeNull();
  });

  test('returns null for null / undefined / empty input', () => {
    expect(extractLinkedIssueNumber(null)).toBeNull();
    expect(extractLinkedIssueNumber(undefined)).toBeNull();
    expect(extractLinkedIssueNumber('')).toBeNull();
  });

  test('captures first match when multiple are present', () => {
    expect(extractLinkedIssueNumber('closes #100, also closes #200')).toBe('100');
  });
});
