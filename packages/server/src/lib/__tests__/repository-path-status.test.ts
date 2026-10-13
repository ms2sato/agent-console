/**
 * Tests for `classifyRepositoryPath`. The injected-`accessFn` cases pin the
 * errno table and the probe mode; the final case uses a real directory and
 * `chmod 000`, which memfs cannot model, so this file runs in the second
 * (real-fs) `bun test` invocation.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { constants } from 'fs';
import { mkdtemp, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { classifyRepositoryPath } from '../repository-path-status.js';

const IS_ROOT = typeof process.geteuid === 'function' && process.geteuid() === 0;

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('classifyRepositoryPath (injected accessFn)', () => {
  it('returns ok when access resolves', async () => {
    expect(await classifyRepositoryPath('/p', async () => {})).toBe('ok');
  });

  it('returns missing for ENOENT', async () => {
    expect(await classifyRepositoryPath('/p', async () => { throw errnoError('ENOENT'); })).toBe('missing');
  });

  it('returns missing for ENOTDIR', async () => {
    expect(await classifyRepositoryPath('/p', async () => { throw errnoError('ENOTDIR'); })).toBe('missing');
  });

  it('returns inaccessible for EACCES', async () => {
    expect(await classifyRepositoryPath('/p', async () => { throw errnoError('EACCES'); })).toBe('inaccessible');
  });

  it('returns inaccessible for EPERM', async () => {
    expect(await classifyRepositoryPath('/p', async () => { throw errnoError('EPERM'); })).toBe('inaccessible');
  });

  it('returns inaccessible for a rejection without an errno code', async () => {
    expect(await classifyRepositoryPath('/p', async () => { throw new Error('boom'); })).toBe('inaccessible');
  });

  it('returns inaccessible for a non-Error rejection', async () => {
    expect(await classifyRepositoryPath('/p', () => Promise.reject('boom'))).toBe('inaccessible');
  });

  it('probes with read + traverse, not bare existence', async () => {
    const calls: Array<[string, number | undefined]> = [];
    await classifyRepositoryPath('/some/repo', async (p, mode) => { calls.push([p, mode]); });
    expect(calls).toEqual([['/some/repo', constants.R_OK | constants.X_OK]]);
  });
});

describe('classifyRepositoryPath (real filesystem)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await chmod(dir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies a nonexistent path as missing', async () => {
    assertRealFs('repository-path-status missing');
    expect(await classifyRepositoryPath(join(tmpdir(), 'repository-path-status-no-such-dir'))).toBe('missing');
  });

  // Root ignores mode bits, so the chmod 000 half cannot observe a denial.
  it.skipIf(IS_ROOT)('classifies a readable directory as ok and the same directory after chmod 000 as inaccessible', async () => {
    assertRealFs('repository-path-status chmod');
    const dir = await mkdtemp(join(tmpdir(), 'repository-path-status-'));
    dirs.push(dir);

    expect(await classifyRepositoryPath(dir)).toBe('ok');

    await chmod(dir, 0o000);
    expect(await classifyRepositoryPath(dir)).toBe('inaccessible');
  });
});
