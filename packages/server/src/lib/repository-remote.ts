import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRemoteUrl } from './git.js';
import { getSourceReposDir } from './config.js';

/**
 * Decide whether `repoPath` lives under `sourceReposDir`. Uses
 * `path.relative` instead of a naive `startsWith` so sibling-prefix paths
 * (e.g., `/tmp/source-repos-other/...` against `/tmp/source-repos`) do NOT
 * match. The relative path must be non-empty (path is not the dir itself),
 * must not escape upwards (no leading `..`), and must not be absolute (which
 * would indicate `path.relative` could not resolve a containment relation,
 * typically on Windows across drives).
 *
 * @internal Exported for testing.
 */
export function isUnderSourceReposDir(
  repoPath: string,
  sourceReposDir: string,
): boolean {
  const rel = path.relative(sourceReposDir, repoPath);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Enrich a Repository with its git remote URL and `clonedSourceRepoPath`.
 *
 * `clonedSourceRepoPath` is set to `repository.path` when that path lives
 * under the resolved [source-repos directory](../../../docs/glossary.md)
 * (i.e. the repo was registered through `POST /api/repositories/clone`,
 * Issue [#834](https://github.com/ms2sato/agent-console/issues/834)), and
 * `null` otherwise. The frontend uses this field to decide whether the
 * unregister UI surfaces the "also remove the cloned source repo" checkbox
 * (Issue [#905](https://github.com/ms2sato/agent-console/issues/905)).
 *
 * Used by both REST API responses and WebSocket broadcasts to ensure
 * consistent repository data across all delivery channels.
 */
export async function withRepositoryRemote(repository: Repository): Promise<Repository> {
  const remoteUrl = await getRemoteUrl(repository.path);
  const sourceReposDir = getSourceReposDir();
  const clonedSourceRepoPath = isUnderSourceReposDir(repository.path, sourceReposDir)
    ? repository.path
    : null;
  return {
    ...repository,
    remoteUrl: remoteUrl ?? undefined,
    clonedSourceRepoPath,
  };
}
