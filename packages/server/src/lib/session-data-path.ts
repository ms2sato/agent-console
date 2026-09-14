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
import { createHash } from 'crypto';

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

/**
 * Compute the `cwd-slug` used to key a quick session's memory directory
 * (epic #1636 Phase 2, `docs/design/embedded-agent-worker.md` "Keying").
 *
 * `<sanitized basename of realCwd>-<first 12 hex chars of sha256(realCwd)>`.
 * The basename keeps the directory human-recognizable when browsing the
 * data root; the hash makes two different paths with the same basename
 * distinct — the SDK's own lossy replace-everything-with-`-` slug collides
 * on `/a/b` vs `/a-b`. The result always satisfies {@link SLUG_PATTERN}'s
 * single-segment grammar (no `/`) and is never `.` / `..` (the hash suffix
 * guarantees a non-degenerate result even when the basename is empty).
 *
 * Pure function — does not touch the filesystem. Callers pass an already
 * realpath'd `cwd`; this function does not resolve symlinks itself.
 */
export function computeQuickCwdSlug(realCwd: string): string {
  const rawBasename = path.basename(realCwd);
  const sanitized = rawBasename.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  const basename = sanitized.length > 0 ? sanitized : 'root';
  const hash = createHash('sha256').update(realCwd).digest('hex').slice(0, 12);
  return `${basename}-${hash}`;
}

/**
 * Shape accepted by {@link resolveSessionScopePayload}. Intentionally narrow
 * so that both `PersistedSession` and `InternalSession` can be passed directly
 * (they share the same scope-related fields).
 */
export interface SessionScopeInput {
  type: 'quick' | 'worktree';
  dataScope?: SessionDataScope;
  dataScopeSlug?: string | null;
}

/**
 * Convert a session's (type, dataScope, dataScopeSlug) triplet into the
 * `{ scope, slug }` payload used by cleanup jobs.
 *
 * Returns `null` when the session is orphaned:
 *   - a worktree session without `dataScope` (legacy/unbackfilled row), or
 *   - a scope/type mismatch (e.g. worktree session with `dataScope='quick'`).
 *
 * Never falls back to `_quick/` — callers that see `null` must log and skip
 * the cleanup job rather than risk cross-scope deletion.
 */
export function resolveSessionScopePayload(
  session: SessionScopeInput
): { scope: SessionDataScope; slug: string | null } | null {
  if (session.type === 'quick') {
    return { scope: 'quick', slug: null };
  }
  if (!session.dataScope) return null;
  // Defensive: a worktree session must always carry the 'repository' scope.
  // Treat any mismatch as orphaned so callers do not silently fall back.
  if (session.dataScope !== 'repository') return null;
  return { scope: session.dataScope, slug: session.dataScopeSlug ?? null };
}
