import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { SystemOpenRequestSchema, SystemOpenVSCodeRequestSchema } from '../system';

describe('SystemOpenRequestSchema', () => {
  it('should accept a valid path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, { path: '/path/to/open' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/open');
    }
  });

  it('should reject a missing path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject an empty path', () => {
    const result = v.safeParse(SystemOpenRequestSchema, { path: '' });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(SystemOpenRequestSchema, {
      path: '/path/to/open',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});

describe('SystemOpenVSCodeRequestSchema', () => {
  it('should accept a valid path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, { path: '/path/to/project' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/project');
    }
  });

  it('should reject a missing path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject an empty path', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, { path: '' });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(SystemOpenVSCodeRequestSchema, {
      path: '/path/to/project',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});
