/**
 * Shared atomic-write primitive for `Write` and `Edit` (FF-1c). Writes to a
 * temp file in the SAME directory as the target (so the final rename is
 * same-filesystem and atomic on POSIX), then renames it onto the target path.
 * On any failure between the temp-write and the rename, best-effort cleans up
 * the temp file before rethrowing — callers decide how to render the error.
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
