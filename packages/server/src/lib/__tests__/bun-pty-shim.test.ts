import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import {
  getLibCandidateFilenames,
  findLibPath,
  formatLibNotFoundError,
} from '../bun-pty-shim.js';

describe('getLibCandidateFilenames', () => {
  const cases: Array<{
    platform: NodeJS.Platform;
    arch: string;
    expected: string[];
  }> = [
    {
      platform: 'darwin',
      arch: 'arm64',
      expected: ['librust_pty_arm64.dylib', 'librust_pty.dylib'],
    },
    { platform: 'darwin', arch: 'x64', expected: ['librust_pty.dylib'] },
    { platform: 'win32', arch: 'x64', expected: ['rust_pty.dll'] },
    { platform: 'win32', arch: 'arm64', expected: ['rust_pty.dll'] },
    {
      platform: 'linux',
      arch: 'arm64',
      expected: ['librust_pty_arm64.so', 'librust_pty.so'],
    },
    { platform: 'linux', arch: 'x64', expected: ['librust_pty.so'] },
  ];

  for (const { platform, arch, expected } of cases) {
    test(`${platform} + ${arch} → ${expected.join(', ')}`, () => {
      expect(getLibCandidateFilenames(platform, arch)).toEqual(expected);
    });
  }
});

describe('findLibPath', () => {
  const here = '/dist';
  const baseDir = join(here, 'rust-pty', 'target', 'release');

  test('returns envValue unchanged when set and existing (operator escape hatch)', () => {
    const envPath = '/custom/path/to/librust_pty.dylib';
    const calls: string[] = [];
    const existsFn = (p: string): boolean => {
      calls.push(p);
      return p === envPath;
    };
    const result = findLibPath('/dist', 'darwin', 'arm64', envPath, existsFn);
    expect(result).toBe(envPath);
    // existsFn should have been called only with the env value, no fallthrough
    expect(calls).toEqual([envPath]);
  });

  test('falls through to candidate search when envValue is undefined', () => {
    const expected = join(baseDir, 'librust_pty_arm64.dylib');
    const existsFn = (p: string): boolean => p === expected;
    const result = findLibPath(here, 'darwin', 'arm64', undefined, existsFn);
    expect(result).toBe(expected);
  });

  test('falls through to candidate search when envValue is an empty string', () => {
    const expected = join(baseDir, 'librust_pty.dylib');
    const existsFn = (p: string): boolean => p === expected;
    const result = findLibPath(here, 'darwin', 'x64', '', existsFn);
    expect(result).toBe(expected);
  });

  test('falls through when envValue is set but does not exist (broken override does not trap)', () => {
    const brokenEnv = '/does/not/exist.dylib';
    const expected = join(baseDir, 'librust_pty.dylib');
    const existsFn = (p: string): boolean => p === expected;
    const result = findLibPath(here, 'darwin', 'x64', brokenEnv, existsFn);
    expect(result).toBe(expected);
  });

  test('darwin arm64 prefers librust_pty_arm64.dylib over librust_pty.dylib when both exist', () => {
    const arm64Path = join(baseDir, 'librust_pty_arm64.dylib');
    const fallbackPath = join(baseDir, 'librust_pty.dylib');
    const existsFn = (p: string): boolean =>
      p === arm64Path || p === fallbackPath;
    const result = findLibPath(here, 'darwin', 'arm64', undefined, existsFn);
    expect(result).toBe(arm64Path);
  });

  test('darwin arm64 returns non-arch fallback librust_pty.dylib when only fallback exists', () => {
    const fallbackPath = join(baseDir, 'librust_pty.dylib');
    const existsFn = (p: string): boolean => p === fallbackPath;
    const result = findLibPath(here, 'darwin', 'arm64', undefined, existsFn);
    expect(result).toBe(fallbackPath);
  });

  test('linux x64 returns <here>/rust-pty/target/release/librust_pty.so when present', () => {
    const expected = join(baseDir, 'librust_pty.so');
    const existsFn = (p: string): boolean => p === expected;
    const result = findLibPath(here, 'linux', 'x64', undefined, existsFn);
    expect(result).toBe(expected);
  });

  test('returns null when neither env nor any candidate exists', () => {
    const existsFn = (): boolean => false;
    const result = findLibPath(here, 'darwin', 'arm64', undefined, existsFn);
    expect(result).toBeNull();
  });

  test('existsFn is called only with paths under <here>/rust-pty/target/release/ (when no env)', () => {
    const calls: string[] = [];
    const existsFn = (p: string): boolean => {
      calls.push(p);
      return false;
    };
    findLibPath(here, 'linux', 'arm64', undefined, existsFn);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.startsWith(baseDir + '/') || call === baseDir).toBe(true);
    }
  });
});

describe('formatLibNotFoundError', () => {
  test('contains BUN_PTY_LIB=<value> when env is set', () => {
    const msg = formatLibNotFoundError('/dist', 'darwin', 'arm64', '/x/y.dylib');
    expect(msg).toContain('BUN_PTY_LIB=/x/y.dylib');
  });

  test('contains BUN_PTY_LIB=<unset> when env is undefined', () => {
    const msg = formatLibNotFoundError('/dist', 'linux', 'x64', undefined);
    expect(msg).toContain('BUN_PTY_LIB=<unset>');
  });

  test('lists each platform-appropriate candidate path under Checked:', () => {
    const msg = formatLibNotFoundError('/dist', 'darwin', 'arm64', undefined);
    const baseDir = join('/dist', 'rust-pty', 'target', 'release');
    expect(msg).toContain('Checked:');
    expect(msg).toContain(join(baseDir, 'librust_pty_arm64.dylib'));
    expect(msg).toContain(join(baseDir, 'librust_pty.dylib'));
  });

  test('mentions dist/rust-pty/target/release/ so an operator knows where to look', () => {
    const msg = formatLibNotFoundError('/dist', 'linux', 'x64', undefined);
    expect(msg).toContain('dist/rust-pty/target/release/');
  });
});
