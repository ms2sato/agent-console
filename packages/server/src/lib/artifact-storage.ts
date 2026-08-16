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
