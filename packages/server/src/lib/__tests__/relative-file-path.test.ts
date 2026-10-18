import { describe, it, expect } from 'bun:test';
import { isValidFilePath } from '../relative-file-path.js';

describe('isValidFilePath', () => {
  it('accepts relative paths, dotfiles and nested paths', () => {
    expect(isValidFilePath('a.ts')).toBe(true);
    expect(isValidFilePath('src/lib/a.ts')).toBe(true);
    expect(isValidFilePath(['.', 'env'].join(''))).toBe(true);
    expect(isValidFilePath('.git/config')).toBe(true);
    expect(isValidFilePath('dir/.hidden')).toBe(true);
  });

  it('accepts the empty string (the tree route uses it for the root; the content route rejects it itself)', () => {
    expect(isValidFilePath('')).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(isValidFilePath('/etc/passwd')).toBe(false);
  });

  it('rejects any path containing .. (substring, so a..b is rejected too)', () => {
    expect(isValidFilePath('../x')).toBe(false);
    expect(isValidFilePath('a/../x')).toBe(false);
    expect(isValidFilePath('a/..')).toBe(false);
    expect(isValidFilePath('a..b')).toBe(false);
  });

  it('rejects a NUL byte', () => {
    expect(isValidFilePath('a\0b')).toBe(false);
    expect(isValidFilePath('\0')).toBe(false);
  });
});
