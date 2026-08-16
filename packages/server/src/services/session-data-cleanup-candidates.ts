import { access } from 'fs/promises';
import * as path from 'path';
import {
  computeSessionDataBaseDir,
  InvalidSessionDataScopeError,
} from '../lib/session-data-path.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:session-data-cleanup-candidates');

export interface BuildSessionDataCleanupTargetsParams {
  configDir: string;
  repositoryId: string;
  repoPath: string;
  repoName: string;
  /** MUST be the real `RepositoryManager.getRepositorySlug` accessor (or an
   *  equivalent) — never a re-implementation of its derivation. If a future
   *  dedicated slug-derivation helper lands, this call site follows
   *  automatically. */
  getRepositorySlug: (id: string) => string | undefined;
  /** Injectable for tests; defaults to a real `fs/promises.access` check. */
  pathExists?: (p: string) => Promise<boolean>;
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
 *   1. The canonical slug from `getRepositorySlug(repositoryId)` (current
 *      session-creation derivation).
 *   2. `path.basename(repoPath)` — closed legacy-flat set.
 *   3. `repoName` — closed legacy-flat set.
 * Do NOT extend the legacy set with new derivations; only #1's canonical
 * accessor should change as the codebase evolves.
 *
 * Each candidate is converted to a path EXCLUSIVELY via
 * `computeSessionDataBaseDir` (the validating single writer). A candidate
 * that fails validation (traversal, malformed slug) is logged and skipped —
 * never hand-joined, never deleted raw. Only existing directories are
 * returned.
 */
export async function buildSessionDataCleanupTargets(
  params: BuildSessionDataCleanupTargetsParams,
): Promise<string[]> {
  const pathExists = params.pathExists ?? defaultPathExists;
  const candidateSlugs = new Set<string>();

  const canonicalSlug = params.getRepositorySlug(params.repositoryId);
  if (canonicalSlug) candidateSlugs.add(canonicalSlug);
  candidateSlugs.add(path.basename(params.repoPath));
  candidateSlugs.add(params.repoName);

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
    if (await pathExists(baseDir)) {
      targets.push(baseDir);
    }
  }
  return targets;
}
