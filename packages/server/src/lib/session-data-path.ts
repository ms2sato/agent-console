/**
 * Session data path — pure helper for deriving a session's canonical base directory.
 *
 * This module is the single writer-of-truth for session-scoped filesystem paths.
 * Callers pass a `(scope, slug)` pair and receive an absolute path that is always
 * under `configDir`. A corrupted or maliciously-crafted slug cannot escape the
 * configured data directory.
 *
 * See docs/design/session-data-path.md for the full specification.
 */
import * as path from 'path';

export type SessionDataScope = 'quick' | 'repository';

/**
 * Thrown when a `(scope, slug)` pair violates the invariants of
 * `computeSessionDataBaseDir`. This is an internal error — it is not intended
 * to be surfaced directly over HTTP.
 */
export class InvalidSessionDataScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionDataScopeError';
  }
}

/**
 * Allowed slug grammar.
 * Permits a single optional slash to support "org/repo" — matches the existing
 * `getRepositoryDir` usage pattern. Disallows path traversal segments such as
 * `..`, leading slashes, backslashes, null bytes, and whitespace.
 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;

/**
 * Returns true if `s` is a syntactically valid slug for use as
 * `data_scope_slug` (i.e. matches {@link SLUG_PATTERN} and does not contain
 * any `.` or `..` path segments). The full traversal/escape check is still
 * performed by {@link computeSessionDataBaseDir}; this helper exists so that
 * callers (e.g. the v18 backfill) can validate candidate slugs without
 * actually computing a path.
 */
export function isValidSlug(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (!SLUG_PATTERN.test(s)) return false;
  for (const segment of s.split('/')) {
    if (segment === '.' || segment === '..') return false;
  }
  return true;
}

/**
 * Compute the canonical base directory for session data from a scope/slug pair.
 * Pure function — does not touch the filesystem.
 *
 * Invariants:
 *   - `scope='quick'` requires `slug === null`
 *   - `scope='repository'` requires a non-empty slug matching {@link SLUG_PATTERN}
 *   - Returned path is always under `configDir` (verified via a prefix check
 *     after `path.resolve`)
 *
 * @throws {InvalidSessionDataScopeError} on any invariant violation.
 */
export function computeSessionDataBaseDir(
  configDir: string,
  scope: SessionDataScope,
  slug: string | null
): string {
  if (scope === 'quick') {
    if (slug !== null) {
      throw new InvalidSessionDataScopeError(
        `scope='quick' requires slug=null, got ${JSON.stringify(slug)}`
      );
    }
    return path.resolve(configDir, '_quick');
  }

  if (scope === 'repository') {
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new InvalidSessionDataScopeError(
        `scope='repository' requires non-empty slug`
      );
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new InvalidSessionDataScopeError(
        `slug ${JSON.stringify(slug)} does not match allowed pattern`
      );
    }
    // Reject `.` / `..` path segments explicitly. The regex allows these
    // because `.` is in the character class, but they have path-traversal
    // meaning and must never appear as a slug segment.
    const segments = slug.split('/');
    for (const segment of segments) {
      if (segment === '.' || segment === '..') {
        throw new InvalidSessionDataScopeError(
          `slug ${JSON.stringify(slug)} contains disallowed path segment ${JSON.stringify(segment)}`
        );
      }
    }
    const resolvedConfig = path.resolve(configDir);
    const candidate = path.resolve(resolvedConfig, 'repositories', slug);
    // Prefix-check: candidate must be strictly within the `repositories`
    // subdirectory of resolvedConfig. Defense in depth — the checks above
    // already rule out traversal, but we verify the final path.
    const repositoriesRoot = path.resolve(resolvedConfig, 'repositories');
    const rootWithSep = repositoriesRoot.endsWith(path.sep)
      ? repositoriesRoot
      : repositoriesRoot + path.sep;
    if (!candidate.startsWith(rootWithSep)) {
      throw new InvalidSessionDataScopeError(
        `computed path escapes configDir: ${candidate}`
      );
    }
    return candidate;
  }

  // Exhaustive check — reachable only if a caller passes an invalid scope
  // value via a type cast.
  throw new InvalidSessionDataScopeError(`unknown scope: ${String(scope)}`);
}
