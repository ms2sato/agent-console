/**
 * The shared file watcher against a REAL recursive `fs.watch` on a real
 * directory (memfs does not model watch events).
 *
 * Real-fs placement: this file runs in the second (real-fs) `bun test`
 * invocation (`package.json`) and calls `assertRealFs` first. The unit tests
 * in file-watch-service.test.ts inject a fake `watch` for the batch logic;
 * this file measures what the fake cannot: that a real write reaches a
 * subscriber, that the viewer-style ignore keeps `node_modules` quiet, and the
 * errno of an unreadable directory (the design doc's EACCES premise).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import {
  subscribeToFileChanges,
  type FileChangeBatch,
  type FileChangeSubscriber,
  type FileWatchFailureReason,
} from '../file-watch-service.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEBOUNCE_MS = 50;

let base: string;

beforeAll(async () => {
  await assertRealFs('file-watch-service-real-fs');
  base = await realpath(await mkdtemp(join(tmpdir(), 'file-watch-real-fs-')));
});

afterAll(async () => {
  // Restore mode bits first so the tree can be removed.
  try {
    await chmod(join(base, 'locked'), 0o755);
  } catch {
    // never created when the test is skipped
  }
  rmSync(base, { recursive: true, force: true });
});

function makeSubscriber(overrides: Partial<FileChangeSubscriber> = {}) {
  const batches: FileChangeBatch[] = [];
  const errors: FileWatchFailureReason[] = [];
  const subscriber: FileChangeSubscriber = {
    ignore: () => false,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: null,
    maxPaths: 200,
    onChange: (batch) => batches.push(batch),
    onError: (reason) => errors.push(reason),
    ...overrides,
  };
  return { subscriber, batches, errors };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

describe('subscribeToFileChanges against a real directory', () => {
  it('delivers a written file, and an ignored directory stays quiet (with a negative control)', async () => {
    const dir = join(base, 'watched');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    const viewerLike = makeSubscriber({
      ignore: (relPath) => relPath.split('/').some((segment) => segment === '.git' || segment === 'node_modules'),
    });
    const unsubscribe = subscribeToFileChanges(dir, viewerLike.subscriber);
    try {
      await writeFile(join(dir, 'sub', 'a.ts'), 'x');
      expect(await waitFor(() => viewerLike.batches.some((b) => b.paths.includes('sub/a.ts')))).toBe(true);

      const before = viewerLike.batches.length;
      await writeFile(join(dir, 'node_modules', 'x.js'), 'x');
      await sleep(DEBOUNCE_MS * 4);
      expect(viewerLike.batches.length).toBe(before);

      // Control: the instrument still sees a non-ignored write right after, so the silence above is the ignore.
      await writeFile(join(dir, 'b.ts'), 'x');
      expect(await waitFor(() => viewerLike.batches.some((b) => b.paths.includes('b.ts')))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('an unreadable subdirectory reports permission-denied (EACCES premise), skipped for root', async () => {
    if (process.getuid?.() === 0) {
      console.warn('file-watch-service-real-fs: running as root, mode bits are bypassed; EACCES premise not measured');
      return;
    }
    const locked = join(base, 'locked');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    const sub = makeSubscriber();
    const unsubscribe = subscribeToFileChanges(locked, sub.subscriber);
    unsubscribe();
    // Recorded in the PR body: the errno that `fs.watch` threw for a 0o000 directory.
    expect(sub.errors).toEqual(['permission-denied']);
  });
});
