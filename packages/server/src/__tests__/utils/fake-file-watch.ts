import { EventEmitter } from 'node:events';
import type { FileWatcher, FileWatchFn } from '../../services/file-watch-service.js';

class FakeWatcher extends EventEmitter implements FileWatcher {
  closes = 0;
  close(): void {
    this.closes += 1;
  }
}

export interface FakeWatch {
  watch: FileWatchFn;
  /** Paths `watch` was called with, in order. */
  calls: string[];
  closeCount: () => number;
  emit: (filename: string | null) => void;
  emitError: (error?: Error) => void;
}

/**
 * A typed stand-in for `fs.watch` for the shared file watcher: records its
 * calls, counts closes, and lets a test emit change events or a watcher error.
 * `throwWith` makes the watch call itself throw (an unopenable path).
 */
export function createFakeWatch(opts: { throwWith?: Error } = {}): FakeWatch {
  const calls: string[] = [];
  const watcher = new FakeWatcher();
  let listener: Parameters<FileWatchFn>[2] | null = null;
  const watch: FileWatchFn = (path, _options, cb) => {
    calls.push(path);
    if (opts.throwWith) throw opts.throwWith;
    listener = cb;
    return watcher;
  };
  return {
    watch,
    calls,
    closeCount: () => watcher.closes,
    emit: (filename) => listener?.('change', filename),
    emitError: (error = new Error('boom')) => watcher.emit('error', error),
  };
}
