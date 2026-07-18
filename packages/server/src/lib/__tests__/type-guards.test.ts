import { describe, it, expect } from 'bun:test';
import * as fs from 'fs/promises';
import { isErrnoException } from '../type-guards.js';

describe('isErrnoException', () => {
  it('returns true for a real fs ENOENT-shaped error', async () => {
    let caught: unknown;
    try {
      await fs.stat('/definitely/does/not/exist/xyz-type-guards-test');
    } catch (err) {
      caught = err;
    }
    expect(isErrnoException(caught)).toBe(true);
    if (isErrnoException(caught)) {
      expect(caught.code).toBe('ENOENT');
    }
  });

  it('returns true for an Error with a string code property', () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    expect(isErrnoException(err)).toBe(true);
  });

  it('returns true for an object with code explicitly set to undefined', () => {
    const err = { code: undefined };
    expect(isErrnoException(err)).toBe(true);
  });

  it('returns false for a plain string', () => {
    expect(isErrnoException('not an error')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isErrnoException(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isErrnoException(undefined)).toBe(false);
  });

  it('returns false for a plain object without a code property', () => {
    expect(isErrnoException({})).toBe(false);
  });

  it('returns false for an object whose code is a non-string, non-undefined value', () => {
    expect(isErrnoException({ code: 123 })).toBe(false);
  });
});
