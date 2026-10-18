import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { watch as fsWatch } from 'node:fs';
import {
  subscribeToFileChanges,
  matchesIgnorePattern,
  pathHasIgnoredSegment,
  type FileChangeBatch,
  type FileChangeSubscriber,
  type FileWatchFailureReason,
} from '../file-watch-service.js';
import { fileWatchIgnorePatterns } from '../../lib/server-config.js';
import { startWatching, stopWatching, isWatching } from '../git-diff-service.js';

// Debounce and max wait use small real delays: bun:test has no fake timers.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeWatch {
  watch: typeof fsWatch;
  calls: string[];
  closeCount: () => number;
  emit: (filename: string | null) => void;
  emitError: (error?: Error) => void;
}

/** A fake `fs.watch` that records its calls and lets the test emit events. */
function createFakeWatch(opts: { throwWith?: Error } = {}): FakeWatch {
  const calls: string[] = [];
  let closes = 0;
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  const emitter = new EventEmitter();
  const watcher = Object.assign(emitter, {
    close: () => {
      closes += 1;
    },
  });
  const watch = ((path: string, _options: unknown, cb: typeof listener) => {
    calls.push(path);
    if (opts.throwWith) throw opts.throwWith;
    listener = cb;
    return watcher;
  }) as unknown as typeof fsWatch;
  return {
    watch,
    calls,
    closeCount: () => closes,
    emit: (filename) => listener?.('change', filename),
    emitError: (error = new Error('boom')) => emitter.emit('error', error),
  };
}

function makeSubscriber(overrides: Partial<FileChangeSubscriber> = {}) {
  const batches: FileChangeBatch[] = [];
  const errors: FileWatchFailureReason[] = [];
  const subscriber: FileChangeSubscriber = {
    ignore: () => false,
    debounceMs: 20,
    maxWaitMs: null,
    maxPaths: 200,
    onChange: (batch) => batches.push(batch),
    onError: (reason) => errors.push(reason),
    ...overrides,
  };
  return { subscriber, batches, errors };
}

let pathCounter = 0;
const uniquePath = () => `/virtual/watch-${pathCounter++}`;

describe('subscribeToFileChanges', () => {
  it('opens ONE watch for two subscribers and closes it with the last unsubscribe', () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const a = makeSubscriber();
    const b = makeSubscriber();
    const unsubA = subscribeToFileChanges(path, a.subscriber, { watch: fake.watch });
    const unsubB = subscribeToFileChanges(path, b.subscriber, { watch: fake.watch });
    expect(fake.calls).toEqual([path]);
    unsubA();
    expect(fake.closeCount()).toBe(0);
    unsubB();
    expect(fake.closeCount()).toBe(1);
  });

  it('applies each subscriber its own ignore rule', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const x = makeSubscriber();
    const y = makeSubscriber({ ignore: (p) => p.startsWith('a') });
    const unsubX = subscribeToFileChanges(path, x.subscriber, { watch: fake.watch });
    const unsubY = subscribeToFileChanges(path, y.subscriber, { watch: fake.watch });
    fake.emit('a/b.ts');
    await sleep(60);
    expect(x.batches).toEqual([{ paths: ['a/b.ts'], overflow: false }]);
    expect(y.batches).toEqual([]);
    unsubX();
    unsubY();
  });

  it('debounces: repeated events for one name give one path, distinct names give each', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const same = makeSubscriber();
    const unsub = subscribeToFileChanges(path, same.subscriber, { watch: fake.watch });
    fake.emit('a.ts');
    fake.emit('a.ts');
    fake.emit('a.ts');
    await sleep(60);
    expect(same.batches).toEqual([{ paths: ['a.ts'], overflow: false }]);
    fake.emit('a.ts');
    fake.emit('b.ts');
    fake.emit('c.ts');
    await sleep(60);
    expect(same.batches[1]).toEqual({ paths: ['a.ts', 'b.ts', 'c.ts'], overflow: false });
    unsub();
  });

  it('max wait delivers during a continuous stream; without a cap nothing arrives until it stops', async () => {
    const fake = createFakeWatch();
    const capped = makeSubscriber({ debounceMs: 50, maxWaitMs: 120 });
    const uncapped = makeSubscriber({ debounceMs: 50, maxWaitMs: null });
    const path = uniquePath();
    const unsubCapped = subscribeToFileChanges(path, capped.subscriber, { watch: fake.watch });
    const unsubUncapped = subscribeToFileChanges(path, uncapped.subscriber, { watch: fake.watch });
    const start = Date.now();
    let firstCappedAt: number | null = null;
    while (Date.now() - start < 260) {
      fake.emit(`f${Math.floor((Date.now() - start) / 10)}.ts`);
      await sleep(10);
      if (firstCappedAt === null && capped.batches.length > 0) firstCappedAt = Date.now() - start;
    }
    expect(firstCappedAt).not.toBeNull();
    expect(firstCappedAt as number).toBeLessThan(200);
    expect(uncapped.batches).toEqual([]);
    await sleep(120);
    expect(uncapped.batches.length).toBe(1);
    unsubCapped();
    unsubUncapped();
  });

  it('overflow: exactly maxPaths distinct is not overflow, one more is, and the next window starts clean', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const sub = makeSubscriber({ maxPaths: 3 });
    const unsub = subscribeToFileChanges(path, sub.subscriber, { watch: fake.watch });
    for (const f of ['1', '2', '3', '3']) fake.emit(f);
    await sleep(60);
    expect(sub.batches[0]).toEqual({ paths: ['1', '2', '3'], overflow: false });
    for (const f of ['1', '2', '3', '4']) fake.emit(f);
    await sleep(60);
    expect(sub.batches[1]).toEqual({ paths: ['1', '2', '3'], overflow: true });
    fake.emit('5');
    await sleep(60);
    expect(sub.batches[2]).toEqual({ paths: ['5'], overflow: false });
    unsub();
  });

  it('unsubscribe with a pending timer delivers nothing; a second unsubscribe is a no-op', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const sub = makeSubscriber({ debounceMs: 30, maxWaitMs: 40 });
    const unsub = subscribeToFileChanges(path, sub.subscriber, { watch: fake.watch });
    fake.emit('a.ts');
    unsub();
    unsub();
    await sleep(90);
    expect(sub.batches).toEqual([]);
    expect(fake.closeCount()).toBe(1);
  });

  it('drops a null filename and delivers nothing for an all-ignored window', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const sub = makeSubscriber({ ignore: (p) => p === 'ignored.ts' });
    const unsub = subscribeToFileChanges(path, sub.subscriber, { watch: fake.watch });
    fake.emit(null);
    fake.emit('ignored.ts');
    await sleep(60);
    expect(sub.batches).toEqual([]);
    unsub();
  });

  it('a subscribe-time EACCES reports permission-denied, returns a no-op and leaves no entry', async () => {
    const path = uniquePath();
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const failing = createFakeWatch({ throwWith: denied });
    const sub = makeSubscriber();
    const unsub = subscribeToFileChanges(path, sub.subscriber, { watch: failing.watch });
    expect(sub.errors).toEqual(['permission-denied']);
    unsub();
    expect(failing.closeCount()).toBe(0);
    // No entry was left behind: the next subscriber opens a fresh watch.
    const ok = createFakeWatch();
    const next = makeSubscriber();
    const unsubNext = subscribeToFileChanges(path, next.subscriber, { watch: ok.watch });
    expect(ok.calls).toEqual([path]);
    unsubNext();
  });

  it('EPERM is permission-denied and any other throw is watch-failed', () => {
    const eperm = createFakeWatch({ throwWith: Object.assign(new Error('x'), { code: 'EPERM' }) });
    const other = createFakeWatch({ throwWith: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    const a = makeSubscriber();
    const b = makeSubscriber();
    subscribeToFileChanges(uniquePath(), a.subscriber, { watch: eperm.watch });
    subscribeToFileChanges(uniquePath(), b.subscriber, { watch: other.watch });
    expect(a.errors).toEqual(['permission-denied']);
    expect(b.errors).toEqual(['watch-failed']);
  });

  it('a post-subscribe watcher error reports watch-failed once to every subscriber and closes the watcher', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const a = makeSubscriber();
    const b = makeSubscriber();
    const unsubA = subscribeToFileChanges(path, a.subscriber, { watch: fake.watch });
    const unsubB = subscribeToFileChanges(path, b.subscriber, { watch: fake.watch });
    fake.emit('pending.ts');
    fake.emitError();
    expect(a.errors).toEqual(['watch-failed']);
    expect(b.errors).toEqual(['watch-failed']);
    expect(fake.closeCount()).toBe(1);
    await sleep(60);
    expect(a.batches).toEqual([]);
    unsubA();
    unsubB();
    expect(fake.closeCount()).toBe(1);
    expect(a.errors).toEqual(['watch-failed']);
  });
});

describe('ignore segment rule', () => {
  const dotEnvLocal = ['.', 'env', '.local'].join('');
  const dotEnv = ['.', 'env'].join('');

  it.each([
    'error.log',
    'logs/error.log',
    'dist/x.js',
    'src/.DS_Store',
    dotEnvLocal,
    'node_modules/a/b.js',
    '.git/index',
  ])('ignores %s with the default list', (relPath) => {
    expect(pathHasIgnoredSegment(relPath, fileWatchIgnorePatterns)).toBe(true);
  });

  it.each([
    'catalog.logic.ts',
    'src/catalog.logic.ts',
    'distribution/x.js',
    '.github/workflows/ci.yml',
    '.gitignore',
    dotEnv,
    'build-tools/a.ts',
  ])('passes %s with the default list', (relPath) => {
    expect(pathHasIgnoredSegment(relPath, fileWatchIgnorePatterns)).toBe(false);
  });

  it('is false for an empty path and for an empty pattern list', () => {
    expect(pathHasIgnoredSegment('', fileWatchIgnorePatterns)).toBe(false);
    expect(pathHasIgnoredSegment('dist/x.js', [])).toBe(false);
  });

  it('matchesIgnorePattern: a dot pattern ends-with, any other pattern is equal', () => {
    expect(matchesIgnorePattern('.log', 'error.log')).toBe(true);
    expect(matchesIgnorePattern('.log', 'catalog.logic.ts')).toBe(false);
    expect(matchesIgnorePattern('dist', 'dist')).toBe(true);
    expect(matchesIgnorePattern('dist', 'distribution')).toBe(false);
  });
});

describe('startWatching / stopWatching as the diff subscriber', () => {
  it('stopWatching closes the watch when no other subscriber remains, and keeps it for a viewer subscriber', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    // The diff subscriber goes through the default `fs.watch`, so a real directory is not needed:
    // subscribe a viewer-like subscriber with the fake first, then let startWatching join the same entry.
    const viewer = makeSubscriber();
    const unsubViewer = subscribeToFileChanges(path, viewer.subscriber, { watch: fake.watch });
    const callback = mock(() => {});
    startWatching(path, callback);
    expect(isWatching(path)).toBe(true);
    expect(fake.calls).toEqual([path]);

    stopWatching(path);
    expect(isWatching(path)).toBe(false);
    expect(fake.closeCount()).toBe(0);

    fake.emit('after.ts');
    await sleep(60);
    expect(viewer.batches).toEqual([{ paths: ['after.ts'], overflow: false }]);
    expect(callback).not.toHaveBeenCalled();

    unsubViewer();
    expect(fake.closeCount()).toBe(1);
  });

  it('the diff callback fires after the debounce for a non-ignored path and not for an ignored one', async () => {
    const fake = createFakeWatch();
    const path = uniquePath();
    const holder = makeSubscriber();
    const unsubHolder = subscribeToFileChanges(path, holder.subscriber, { watch: fake.watch });
    const callback = mock(() => {});
    startWatching(path, callback);
    fake.emit('node_modules/x.js');
    await sleep(400);
    expect(callback).not.toHaveBeenCalled();
    fake.emit('catalog.logic.ts');
    await sleep(400);
    expect(callback).toHaveBeenCalledTimes(1);
    stopWatching(path);
    unsubHolder();
  });
});
