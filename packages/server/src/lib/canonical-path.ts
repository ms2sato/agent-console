import * as path from 'path';
import { realpath } from 'fs/promises';

/**
 * Canonical form of a filesystem path, for comparing a path git emitted (git
 * prints realpaths) with a path this app stored (`path.resolve`d, symlinks
 * kept).
 *
 * Resolves `p` to an absolute path first, then to its realpath. When the
 * realpath cannot be computed (ENOENT, EACCES, ...) the resolved string is
 * returned unchanged: a missing path compares as itself and this never throws.
 *
 * Use this only to COMPARE. Stored paths stay `path.resolve`d because other
 * code matches them by string prefix against configured directories.
 */
export async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}
