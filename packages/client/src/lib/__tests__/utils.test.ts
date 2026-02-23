import { describe, it, expect } from 'bun:test';
import { cn } from '../utils';

describe('cn', () => {
  it('should return a single class string as-is', () => {
    expect(cn('p-4')).toBe('p-4');
  });

  it('should merge multiple class strings', () => {
    expect(cn('font-bold', 'text-lg')).toBe('font-bold text-lg');
  });

  it('should ignore falsy values', () => {
    expect(cn('p-4', false, null, undefined, 0, '', 'mt-2')).toBe('p-4 mt-2');
  });

  it('should deduplicate Tailwind classes with last-wins precedence', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  it('should resolve conflicting Tailwind utility classes', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('should return empty string when called with no arguments', () => {
    expect(cn()).toBe('');
  });

  it('should accept an array of classes', () => {
    expect(cn(['p-4', 'mt-2'])).toBe('p-4 mt-2');
  });

  it('should handle mixed input types', () => {
    const result = cn(
      'base',
      ['array-class'],
      { 'object-true': true, 'object-false': false },
      undefined,
      null,
      false,
      'last'
    );
    expect(result).toBe('base array-class object-true last');
  });
});
