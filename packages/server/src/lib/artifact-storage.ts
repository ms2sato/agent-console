/**
 * Filesystem storage for HTML artifacts (phase 1).
 *
 * Bytes live at `<AGENT_CONSOLE_HOME>/artifacts/<userId>/<artifactId>.html`,
 * written and read by the server process directly -- no privilege
 * elevation anywhere in this feature (multi-user viewers arrive over HTTP,
 * never through the filesystem). See docs/design/html-artifacts.md §5.1.
 *
 * This module owns file I/O only. Metadata (the `artifacts` DB table) is
 * owned by `repositories/artifact-repository.ts`.
 *
 * Deliberately Bun-native throughout (`Bun.write` / `Bun.file`), never
 * `node:fs/promises`: `Bun.write` auto-creates missing intermediate
 * directories, and staying off `node:fs` avoids the process-global
 * `mock.module('fs/promises')` memfs interception used pervasively by this
 * codebase's other test files (`.claude/rules/testing.md` Anti-Pattern #2) --
 * mixing a memfs-backed `mkdir` with a real-disk `Bun.write` would write the
 * directory and the file to two different, disconnected volumes.
 */
import { $ } from 'bun';
import { dirname } from 'node:path';
import { getArtifactFilePath } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('artifact-storage');

/**
 * Write an artifact's HTML content to its on-disk location. `Bun.write`
 * creates the per-user directory automatically when it does not yet exist.
 */
export async function writeArtifactFile(userId: string, artifactId: string, content: string): Promise<void> {
  const filePath = getArtifactFilePath(userId, artifactId);
  await Bun.write(filePath, content);
}

/**
 * Atomically move `from` over `to` (same directory) through Bun's shell
 * `mv` builtin, which calls `renameat(2)` itself: no external process, real
 * disk, and -- like `Bun.write` / `Bun.file` above -- outside the
 * process-global `mock.module('fs/promises')` memfs interception. Bun has no
 * rename API of its own, and an ordinary `node:fs/promises` import here would
 * bind to whichever volume the first test file loaded in the process picked
 * (real or memfs), splitting the temp file and the target across two disks
 * (see the header). `-f` makes it overwrite; a non-zero exit throws.
 *
 * @internal Exported for testing.
 */
export async function moveFileAtomically(from: string, to: string): Promise<void> {
  // rename(2) is atomic only within one directory (one filesystem); refuse anything else.
  if (dirname(from) !== dirname(to)) {
    throw new Error(`Refusing a non-atomic move across directories: ${from} -> ${to}`);
  }
  // Header rule: this file is Bun-native and never imports node:fs/promises; strace of this
  // builtin shows it issues renameat(2) directly (no copy, no external process). Paths are
  // tagged-template INTERPOLATIONS (escaped as single arguments), never string-built.
  await $`mv -f ${from} ${to}`.quiet();
}

/** Test seam for the replace step (default: {@link moveFileAtomically}). */
export interface ReplaceArtifactFileDeps {
  moveFile?: (from: string, to: string) => Promise<void>;
}

/**
 * Replace an existing artifact's HTML content atomically: write the new bytes
 * to a temp file in the SAME directory, then move it over the target with
 * `rename` semantics. A reader mid-request therefore sees the old bytes or the
 * new bytes, never a torn file (the serving route reads the file per
 * request). On any failure the temp file is removed (best-effort) and the
 * error rethrown; the target is untouched until the move succeeds.
 * `writeArtifactFile` (create) is unchanged.
 */
export async function replaceArtifactFile(
  userId: string,
  artifactId: string,
  content: string,
  deps: ReplaceArtifactFileDeps = {},
): Promise<void> {
  const filePath = getArtifactFilePath(userId, artifactId);
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    await Bun.write(tempPath, content);
    await (deps.moveFile ?? moveFileAtomically)(tempPath, filePath);
  } catch (err) {
    try {
      await Bun.file(tempPath).delete();
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof Error && 'code' in cleanupErr && (cleanupErr as NodeJS.ErrnoException).code === 'ENOENT')) {
        logger.warn({ err: cleanupErr, artifactId, userId }, 'Failed to remove the temp file after a failed artifact replace');
      }
    }
    throw err;
  }
  logger.debug({ userId, artifactId }, 'Artifact file replaced');
}

/**
 * Read an artifact's HTML content. Returns `null` when the file does not
 * exist (e.g. a DB row survives without its file, or vice versa).
 */
export async function readArtifactFile(userId: string, artifactId: string): Promise<string | null> {
  const filePath = getArtifactFilePath(userId, artifactId);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  return file.text();
}

/**
 * Delete an artifact's HTML file. Tolerant of a missing file (mirroring the
 * `rm -f` semantics used elsewhere in this codebase for non-elevated
 * cleanup, e.g. `worktree-service.ts`'s `fsPromises.rm({ force: true })`
 * fallback) so a partially-consistent state (row without file) never throws
 * here -- `Bun.file(...).delete()` itself throws ENOENT on a missing file,
 * so that specific error is swallowed; anything else propagates.
 */
export async function deleteArtifactFile(userId: string, artifactId: string): Promise<void> {
  const filePath = getArtifactFilePath(userId, artifactId);
  try {
    await Bun.file(filePath).delete();
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  logger.debug({ userId, artifactId }, 'Artifact file deleted');
}
