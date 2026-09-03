import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Path computation ONLY -- no directory creation or validation here. That
 * logic (mkdir + mode/owner/group verification) stays in
 * `routes/workers.ts`'s `ensureUploadDir`, which is the only current writer
 * of the directory. This function exists so a second reader --
 * `EmbeddedAgentWorkerService`, which needs the same path to populate
 * `init.context.attachmentRoots` -- does not duplicate the per-uid
 * computation.
 *
 * Upload directory is per-uid under the OS temp directory; see
 * `routes/workers.ts`'s file-header comment for the full rationale (why
 * per-uid, why /tmp, mode/gid contract per AUTH_MODE).
 */
export function resolveUploadDir(): string {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : 'shared';
  return join(tmpdir(), `agent-console-uploads-${uid}`);
}
