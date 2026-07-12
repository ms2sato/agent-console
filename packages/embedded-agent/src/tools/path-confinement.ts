/**
 * Path confinement for builtin subprocess-local tools.
 *
 * Resolves a caller-supplied path against the session's `locationPath` and
 * rejects anything that resolves (after following symlinks) outside it. This
 * is the "minimum floor" for FF-1a — a later fast-follow (FF-2) builds
 * OS-level sandboxing on top; this module deliberately stays a pure-userland
 * check.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export type ConfinementResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; message: string };

/** Verbatim rejection message — asserted by callers and tests. */
export const CONFINEMENT_REJECTED_MESSAGE = 'Access outside session location is not permitted.';

/**
 * Resolve the real (symlink-following) path of the nearest existing ancestor
 * of `candidate`, then rejoin the non-existent tail segments unresolved
 * (segments that don't exist cannot be symlinks).
 */
async function realpathNearestAncestor(candidate: string): Promise<string> {
  const tail: string[] = [];
  let current = candidate;

  while (true) {
    try {
      const real = await fsPromises.realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return path.join(current, ...tail.reverse());
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `rawPath` (absolute or relative to `locationPath`) and verify it is
 * confined within `locationPath` after following symlinks. Never throws for
 * "path does not exist" — that is the calling tool's concern, not
 * confinement's. Returns the verbatim {@link CONFINEMENT_REJECTED_MESSAGE} on
 * rejection.
 */
export async function resolveConfinedPath(
  rawPath: string,
  locationPath: string,
): Promise<ConfinementResult> {
  const resolvedLocationPath = await fsPromises.realpath(locationPath);

  const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(locationPath, rawPath);
  const resolvedPath = await realpathNearestAncestor(candidate);

  const confined =
    resolvedPath === resolvedLocationPath || resolvedPath.startsWith(resolvedLocationPath + path.sep);

  if (!confined) {
    return { ok: false, message: CONFINEMENT_REJECTED_MESSAGE };
  }
  return { ok: true, resolvedPath };
}
