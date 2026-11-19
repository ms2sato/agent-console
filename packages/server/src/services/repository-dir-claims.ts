import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRepositoriesDir, getRepositoryDir } from '../lib/config.js';
import { isValidSlug } from '../lib/session-data-path.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:repository-dir-claims');

const WORKTREES_SEGMENT = 'worktrees';

/**
 * Map a `worktrees` row path to the repository directory it was placed under,
 * or `null` when the path is not of the placement shape.
 *
 * Placement shape (exact): `<repositoriesDir>/<slug>/worktrees/<one segment>`
 * with `isValidSlug(slug)` (a flat `repo` or an `org/repo` slug). Anything else
 * contributes nothing: the main checkout, a path outside `repositoriesDir`, a
 * path with extra depth, a relative path, a path with a `..` segment. A path
 * that has the placement shape but whose slug is invalid is logged at warn.
 *
 * The returned directory is always produced by `getRepositoryDir(slug)`; a raw
 * row path is never returned.
 */
export function repositoryDirFromWorktreePath(worktreePath: string): string | null {
  if (!path.isAbsolute(worktreePath)) return null;
  if (worktreePath.split(/[\\/]/).includes('..')) return null;

  const rel = path.relative(getRepositoriesDir(), worktreePath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }

  const segments = rel.split(path.sep);
  if (segments.length < 3 || segments[segments.length - 2] !== WORKTREES_SEGMENT) {
    return null;
  }

  const slug = segments.slice(0, -2).join('/');
  if (!isValidSlug(slug)) {
    logger.warn({ worktreePath, slug }, 'Ignoring worktree row with placement shape but invalid slug');
    return null;
  }
  return getRepositoryDir(slug);
}

export interface FindClaimedRepositoryDirsParams {
  /** The repository being unregistered; never claims against itself. */
  repo: Pick<Repository, 'id'>;
  /** Every registered repository, `repo` included (it is filtered out by id). */
  registeredRepositories: ReadonlyArray<Pick<Repository, 'id' | 'path'>>;
  /** Paths of the `worktrees` rows of one repository. */
  listWorktreePaths: (repositoryId: string) => Promise<string[]>;
  /** Slug derivation, `deriveRepositorySlug` in production. */
  deriveSlug: (repoPath: string, fallback: string) => Promise<string>;
}

/**
 * What other registered repositories claim under `repositories/`, by what the
 * claimant actually owns.
 *
 * - `subtree`: the claimant's canonical slug directory and the directory of each
 *   of its worktree rows. Everything under such a directory belongs to it.
 * - `point`: its path basename directory and its checkout path. Speculative
 *   (the basename) or possibly containing the whole data root (the checkout),
 *   so only the directory itself and its ancestors are protected.
 */
export interface RepositoryDirClaims {
  subtree: Set<string>;
  point: Set<string>;
}

/**
 * Directories under `repositories/` that a registered repository OTHER than
 * `repo` claims, by (a) its current canonical slug (subtree), (b) its path
 * basename (point), (c) one of its own worktree rows living under it (subtree),
 * or (d) its own checkout path (point; a linked worktree checkout can register
 * and sit under a directory other rows record). Claim (d) is `path.resolve`d,
 * not realpath'd: targets are built from the never-realpath'd
 * `getRepositoriesDir()`, and realpath fails for a missing checkout. A
 * repository without a remote has the same directory for (a) and (b); it is then
 * in both kinds and the subtree rule applies. Deleting too little is the safe
 * direction: a shared flat directory is ambiguous by construction.
 *
 * A derivation that throws for another repository degrades that repository: it
 * keeps its checkout path, its basename and its worktree-row directories; only
 * the canonical-slug claim is missing. It never aborts the caller.
 */
export async function findClaimedRepositoryDirs(
  params: FindClaimedRepositoryDirsParams,
): Promise<RepositoryDirClaims> {
  const claims: RepositoryDirClaims = { subtree: new Set(), point: new Set() };
  const claim = (kind: keyof RepositoryDirClaims, slug: string): void => {
    if (isValidSlug(slug)) claims[kind].add(getRepositoryDir(slug));
  };

  for (const other of params.registeredRepositories) {
    if (other.id === params.repo.id) continue;

    claims.point.add(path.resolve(other.path));

    const basename = path.basename(other.path);
    claim('point', basename);
    try {
      claim('subtree', await params.deriveSlug(other.path, basename));
    } catch (err) {
      logger.warn(
        { repositoryId: other.id, err },
        'Slug derivation failed for another registered repository; it keeps its checkout path, basename and worktree-row directories, only the canonical-slug claim is missing',
      );
    }

    for (const worktreePath of await params.listWorktreePaths(other.id)) {
      const dir = repositoryDirFromWorktreePath(worktreePath);
      if (dir !== null) claims.subtree.add(dir);
    }
  }
  return claims;
}

/**
 * Whether `dir` must be left alone because another repository claims it:
 * `dir` is a claimed directory or an ancestor of one (either kind), or a
 * descendant of a subtree claim. All comparisons are by path segment, so
 * `repositories/acme` does not match `repositories/acme-old`. A descendant of a
 * point claim is NOT protected: a basename claim is speculative and a checkout
 * can contain the whole data root.
 */
export function isProtectedByClaim(dir: string, claims: RepositoryDirClaims): boolean {
  const prefix = dir + path.sep;
  for (const claimed of [...claims.subtree, ...claims.point]) {
    if (claimed === dir || claimed.startsWith(prefix)) return true;
  }
  for (const claimed of claims.subtree) {
    if (dir.startsWith(claimed + path.sep)) return true;
  }
  return false;
}
