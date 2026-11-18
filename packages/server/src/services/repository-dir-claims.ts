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
 * Directories under `repositories/` that a registered repository OTHER than
 * `repo` claims, by (a) its current canonical slug, (b) its path basename, or
 * (c) one of its own worktree rows living under it. Deleting too little is the
 * safe direction: a shared flat directory is ambiguous by construction.
 *
 * A derivation that throws for another repository degrades to that repository
 * claiming its basename only; it never aborts the caller.
 */
export async function findClaimedRepositoryDirs(
  params: FindClaimedRepositoryDirsParams,
): Promise<Set<string>> {
  const claimed = new Set<string>();
  const claim = (slug: string): void => {
    if (isValidSlug(slug)) claimed.add(getRepositoryDir(slug));
  };

  for (const other of params.registeredRepositories) {
    if (other.id === params.repo.id) continue;

    const basename = path.basename(other.path);
    claim(basename);
    try {
      claim(await params.deriveSlug(other.path, basename));
    } catch (err) {
      logger.warn(
        { repositoryId: other.id, err },
        'Slug derivation failed for another registered repository; it claims its basename only',
      );
    }

    for (const worktreePath of await params.listWorktreePaths(other.id)) {
      const dir = repositoryDirFromWorktreePath(worktreePath);
      if (dir !== null) claimed.add(dir);
    }
  }
  return claimed;
}
