import { constants, promises as fsPromises } from 'fs';
import { isErrnoException } from './type-guards.js';

export type RepositoryPathStatus = 'ok' | 'missing' | 'inaccessible';

/**
 * Classify what the server process can observe about a repository path.
 *
 * The probe asks for read + traverse (`R_OK | X_OK`), which is what git needs.
 * The default existence-only mode would pass for a `chmod 000` root, because
 * existence is decided through the parent directory, and `'inaccessible'`
 * would be unreachable.
 *
 * `'missing'` is reserved for ENOENT / ENOTDIR. Every other rejection
 * (EACCES, EPERM, EIO, ELOOP, or a rejection with no errno code) is
 * `'inaccessible'`: the name states the observation, not a cause, and the
 * caller keeps the errno for its log.
 */
export async function classifyRepositoryPath(
  path: string,
  accessFn: (path: string, mode?: number) => Promise<void> = fsPromises.access,
): Promise<RepositoryPathStatus> {
  try {
    await accessFn(path, constants.R_OK | constants.X_OK);
    return 'ok';
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return 'missing';
    }
    return 'inaccessible';
  }
}
