import { access } from 'fs/promises';
import * as path from 'path';
import {
  computeSessionDataBaseDir,
  InvalidSessionDataScopeError,
} from '../lib/session-data-path.js';
import { deriveRepositorySlug } from '../lib/git.js';
import { isProtectedByClaim, type RepositoryDirClaims } from './repository-dir-claims.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:session-data-cleanup-candidates');

export interface BuildSessionDataCleanupTargetsParams {
  configDir: string;
  repositoryId: string;
  repoPath: string;
  /** MUST be the real `deriveRepositorySlug` (`lib/git.ts`) — never a
   *  re-implementation of its derivation. Defaults to the real function;
   *  injectable so tests can stub the derivation without touching the git
   *  filesystem. */
  deriveSlug?: (repoPath: string, fallback: string) => Promise<string>;
  /** Injectable for tests; defaults to a real `fs/promises.access` check. */
  pathExists?: (p: string) => Promise<boolean>;
  /**
   * Base directories another registered repository claims (see
   * `findClaimedRepositoryDirs`). A candidate whose directory is protected by a claim is
   * skipped with an info log. Absent == nothing claimed.
   */
  claimedDirs?: RepositoryDirClaims;
}

const defaultPathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the list of session-data base directories (outputs/messages/memos
 * roots) to remove when a repository is unregistered.
 *
 * Candidate slugs, deduplicated:
 *   1. The canonical slug from `deriveSlug(repoPath, basename(repoPath))`
 *      (the same derivation now used at session-creation time). Never
 *      falsy: `deriveRepositorySlug` is total.
 *   2. `path.basename(repoPath)` — closed legacy-flat set.
 * The repository's display `name` is never a candidate: it is a mutable free-text
 * label and must not be able to address a directory that gets deleted.
 * Do NOT extend the legacy set with new derivations; only #1's canonical
 * derivation should change as the codebase evolves.
 *
 * Each candidate is converted to a path EXCLUSIVELY via
 * `computeSessionDataBaseDir` (the validating single writer). A candidate
 * that fails validation (traversal, malformed slug) is logged and skipped —
 * never hand-joined, never deleted raw. A candidate directory in
 * `claimedDirs` is skipped (deleting too little is the safe direction). Only
 * existing directories are returned.
 */
export async function buildSessionDataCleanupTargets(
  params: BuildSessionDataCleanupTargetsParams,
): Promise<string[]> {
  const pathExists = params.pathExists ?? defaultPathExists;
  const deriveSlug = params.deriveSlug ?? deriveRepositorySlug;
  const candidateSlugs = new Set<string>();

  const canonicalSlug = await deriveSlug(params.repoPath, path.basename(params.repoPath));
  candidateSlugs.add(canonicalSlug);
  candidateSlugs.add(path.basename(params.repoPath));

  const targets: string[] = [];
  for (const slug of candidateSlugs) {
    let baseDir: string;
    try {
      baseDir = computeSessionDataBaseDir(params.configDir, 'repository', slug);
    } catch (err) {
      if (err instanceof InvalidSessionDataScopeError) {
        logger.warn(
          { repositoryId: params.repositoryId, slug, err: err.message },
          'Skipping invalid session-data cleanup candidate slug',
        );
        continue;
      }
      throw err;
    }
    if (params.claimedDirs && isProtectedByClaim(baseDir, params.claimedDirs)) {
      logger.info(
        { repositoryId: params.repositoryId, slug, baseDir },
        'Skipping session-data cleanup candidate claimed by another registered repository',
      );
      continue;
    }
    if (await pathExists(baseDir)) {
      targets.push(baseDir);
    }
  }
  return targets;
}
