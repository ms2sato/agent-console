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

function isConfinedWithin(resolvedPath: string, resolvedRoot: string): boolean {
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

/**
 * Resolve every `extraRoots` entry independently, dropping (rather than
 * throwing on) any that fail to realpath. An extra root might not exist on
 * disk yet (e.g. no upload has ever happened for this OS user) -- that must
 * not crash confinement for every tool call. If a root doesn't exist,
 * nothing meaningful can exist under it either, so dropping it is safe; the
 * eventual file read will fail with a normal not-found error regardless.
 */
async function resolveExistingRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fsPromises.realpath(root);
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((r): r is string => r !== null);
}

/**
 * Resolve `rawPath` (absolute or relative to `locationPath`) and verify it is
 * confined within `locationPath`, OR within one of `extraRoots`, after
 * following symlinks. `extraRoots` lets a caller extend confinement beyond
 * the session's own working directory (e.g. `openai-api`'s builtin `Read`
 * tool reaching a shared message-attachment upload directory -- see Issue
 * #1570). `locationPath` remains the sole base for resolving a RELATIVE
 * `rawPath`; `extraRoots` only widen where an ABSOLUTE result is allowed to
 * land.
 *
 * Never throws for "path does not exist" against the PRIMARY (`locationPath`)
 * root -- that is the calling tool's concern, not confinement's. Returns the
 * verbatim {@link CONFINEMENT_REJECTED_MESSAGE} on rejection.
 */
export async function resolveConfinedPath(
  rawPath: string,
  locationPath: string,
  extraRoots: string[] = [],
): Promise<ConfinementResult> {
  const resolvedLocationPath = await fsPromises.realpath(locationPath);
  const resolvedExtraRoots = await resolveExistingRoots(extraRoots);

  const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(locationPath, rawPath);
  const resolvedPath = await realpathNearestAncestor(candidate);

  const confined =
    isConfinedWithin(resolvedPath, resolvedLocationPath) ||
    resolvedExtraRoots.some((root) => isConfinedWithin(resolvedPath, root));

  if (!confined) {
    return { ok: false, message: CONFINEMENT_REJECTED_MESSAGE };
  }
  return { ok: true, resolvedPath };
}
