/**
 * Shared atomic-write primitive for `Write` and `Edit` (FF-1c). Writes to a
 * temp file in the SAME directory as the target (so the final rename is
 * same-filesystem and atomic on POSIX), then renames it onto the target path.
 * On any failure between the temp-write and the rename, best-effort cleans up
 * the temp file before rethrowing — callers decide how to render the error.
 *
 * Mode preservation: the rename replaces the target's inode, so an existing
 * file's permission bits (notably the executable bit) would otherwise reset
 * to the process umask default. Before renaming, the target's existing mode
 * (if any) is copied onto the temp file. This does NOT preserve hardlinks —
 * the rename still severs them, since the target inode is replaced regardless
 * of the temp file's mode. Preserving hardlink identity would require an
 * in-place write (truncate+write) instead, which sacrifices crash safety;
 * that trade-off is accepted here per architect review (Issue #1067).
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface AtomicWriteResult {
  bytesWritten: number;
}

/**
 * Writes `content` to `resolvedPath` via a temp-file-then-rename sequence.
 * Never leaves a partially-written file at `resolvedPath` — either the whole
 * write lands (via the atomic rename) or `resolvedPath` is untouched.
 */
export async function atomicWrite(resolvedPath: string, content: string): Promise<AtomicWriteResult> {
  const tempPath = path.join(path.dirname(resolvedPath), `${path.basename(resolvedPath)}.tmp-${crypto.randomUUID()}`);
  try {
    const bytesWritten = await Bun.write(tempPath, content);
    try {
      const { mode } = await fsPromises.stat(resolvedPath);
      await fsPromises.chmod(tempPath, mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Target does not exist yet -- new file, no mode to preserve.
    }
    await fsPromises.rename(tempPath, resolvedPath);
    return { bytesWritten };
  } catch (err) {
    try {
      await fsPromises.rm(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only; the original error below is what matters.
    }
    throw err;
  }
}
