/**
 * Real-filesystem test for `createDisposableMultiUserHome` (Issue #1713).
 * Uses real temp dirs under `os.tmpdir()`, cleaned in `afterEach` -- this
 * helper's whole job is emulating real `chmod`/`mkdir`/setgid-inheritance
 * behavior, so a memfs mock would defeat the point (same rationale as
 * `packages/server/src/lib/__tests__/memory-dir.test.ts`, whose real
 * multi-user setgid test this file mirrors).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, lstat, rm } from 'node:fs/promises';
import { isMemfsActive } from '../../../packages/server/src/__tests__/utils/memfs-detection.js';
import { join } from 'node:path';
import { createDisposableMultiUserHome } from '../disposable-multi-user-home.js';

const IS_ROOT = typeof process.geteuid === 'function' && process.geteuid() === 0;

const cleanupPaths: string[] = [];
const umaskRestores: number[] = [];

afterEach(async () => {
  while (umaskRestores.length > 0) {
    process.umask(umaskRestores.pop()!);
  }
  while (cleanupPaths.length > 0) {
    const dir = cleanupPaths.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('createDisposableMultiUserHome (real fs, Linux only)', () => {
  it('creates a home with mode exactly 2775 + expected gid, and a child mkdir (no mode arg) inherits 2775 under the set umask', async () => {
    if (process.platform !== 'linux' || typeof process.getgid !== 'function') {
      console.warn('Skipping: not Linux or no process.getgid');
      return;
    }
    if (IS_ROOT) {
      console.warn('Skipping: running as root (permission checks bypassed)');
      return;
    }
    // Same discipline as memory-dir.test.ts: in the full server suite,
    // fs/promises is process-globally swapped for memfs, and chmod(1) on a
    // memfs-only directory / the kernel's setgid inheritance cannot be
    // observed there. Run this file alone to exercise the real behavior.
    if (await isMemfsActive()) {
      console.warn('[skip] memfs is active in this process; run this file alone to exercise real setgid inheritance.');
      return;
    }

    const result = await createDisposableMultiUserHome('disposable-multi-user-home-test-');
    cleanupPaths.push(result.path);
    if (!result.ok) {
      // A tmpfs that genuinely refuses setgid is exactly the "cannot run"
      // case this helper exists to report loudly -- fail the test with the
      // reason rather than silently skipping, since CI's own /tmp is
      // expected to honour setgid. ok:false never touches process.umask(),
      // so there is nothing to push onto umaskRestores here.
      throw new Error(`createDisposableMultiUserHome returned ok:false unexpectedly: ${result.reason}`);
    }
    umaskRestores.push(result.prevUmask);

    const homeSt = await lstat(result.path);
    expect(homeSt.mode & 0o7777).toBe(0o2775);
    expect(homeSt.gid).toBe(process.getgid());

    // Child segment created the way memory-dir.ts's ensureMemoryDir creates
    // multi-user segments: mkdir with NO mode argument, relying entirely on
    // the parent's setgid bit + the process umask set by
    // createDisposableMultiUserHome (0o002) for its mode.
    const childDir = join(result.path, 'child');
    await mkdir(childDir);
    const childSt = await lstat(childDir);
    expect(childSt.mode & 0o7777).toBe(0o2775);
    expect(childSt.gid).toBe(process.getgid());
  });

  // POLARITY, measured: without the chmod 2775 step, a plain mkdtemp
  // directory has no setgid bit, so a child mkdir (no mode arg) under the
  // SAME 0o002 umask this helper sets comes out 0775, not 2775 -- missing
  // both the setgid bit (so grandchildren would not inherit it either) and,
  // in production, failing the memory layer's mode-exactness check against
  // the 2775 contract. This is exactly the pre-#1713 bug (a plain `mkdir -p`
  // disposable home): reproduced directly here rather than only asserted in
  // prose, per workflow.md's "a check's existence is not its detection
  // power".
  it('polarity: without the setgid chmod, a child mkdir under the same umask comes out 0775, not 2775', async () => {
    if (process.platform !== 'linux' || typeof process.getgid !== 'function') {
      console.warn('Skipping: not Linux or no process.getgid');
      return;
    }
    if (IS_ROOT) {
      console.warn('Skipping: running as root (permission checks bypassed)');
      return;
    }
    if (await isMemfsActive()) {
      console.warn('[skip] memfs is active in this process; run this file alone to exercise real setgid inheritance.');
      return;
    }

    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const plainHome = await mkdtemp(join(tmpdir(), 'disposable-multi-user-home-polarity-'));
    cleanupPaths.push(plainHome);

    const prevUmask = process.umask(0o002);
    umaskRestores.push(prevUmask);

    const childDir = join(plainHome, 'child');
    await mkdir(childDir);
    const childSt = await lstat(childDir);
    expect(childSt.mode & 0o7777).toBe(0o775);
    expect(childSt.mode & 0o7777).not.toBe(0o2775);
  });
});
