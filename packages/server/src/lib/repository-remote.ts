import * as path from 'path';
import type { Repository } from '@agent-console/shared';
import { getRemoteUrl } from './git.js';
import { getSourceReposDir } from './config.js';

/**
 * Decide whether `repoPath` lives under `sourceReposDir`. Uses
 * `path.relative` instead of a naive `startsWith` so sibling-prefix paths
 * (e.g., `/tmp/source-repos-other/...` against `/tmp/source-repos`) do NOT
 * match. The relative path must be non-empty (the path is not the dir
 * itself), must not be the literal parent escape `..` and must not begin
 * with a `..` segment (`..${sep}...`), and must not be absolute (which
 * would indicate `path.relative` could not resolve a containment relation,
 * typically on Windows across drives).
 *
 * Both operands are normalized through `path.resolve` before the
 * containment check. `getSourceReposDir()` can return a relative path
 * (operator-supplied `AGENT_CONSOLE_SOURCE_REPOS_DIR`, or a relative
 * `AGENT_CONSOLE_HOME` propagated through `path.join`); `repo.path` is
 * always absolute (built via `path.resolve` in `registerRepository`).
 * Without the resolve step, `path.relative(relative_dir, absolute_path)`
 * resolves both against `process.cwd()` and can misclassify valid clones
 * when cwd differs from where the relative source-repos dir resolves at
 * config-read time. The resolve step makes the check stable regardless
 * of the order in which the env var and cwd were established.
 *
 * We deliberately do NOT reject ALL relative paths whose string starts
 * with `..` (`!rel.startsWith('..')`) because that would also reject
 * legitimate in-tree directory names that happen to begin with two dots
 * (e.g., `..hidden-org/repo` -- a real directory inside the source-repos
 * tree). Only the literal `..` segment or a `..`+separator prefix is a
 * parent-directory walk.
 *
 * @internal Exported for testing.
 */
export function isUnderSourceReposDir(
  repoPath: string,
  sourceReposDir: string,
): boolean {
  const absoluteSourceReposDir = path.resolve(sourceReposDir);
  const absoluteRepoPath = path.resolve(repoPath);
  const rel = path.relative(absoluteSourceReposDir, absoluteRepoPath);
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Enrich a Repository with its git remote URL and `clonedSourceRepoPath`.
 *
 * `clonedSourceRepoPath` is set to `repository.path` when that path lives
 * under the resolved [source-repos directory](../../../docs/glossary.md)
 * (`getSourceReposDir()`) -- this is a pure path-containment check, NOT a
 * provenance check. Any repository whose registered path falls inside the
 * source-repos prefix is treated as a "cloned source repo" for the purposes
 * of the unregister UI, regardless of how the directory was created (via
 * `POST /api/repositories/clone`, an operator-side `git clone`, or any
 * other means). Set to `null` when the path is outside that prefix.
 *
 * The frontend uses this field to decide whether the unregister UI
 * surfaces the "also remove the cloned source repo" checkbox (Issue
 * [#905](https://github.com/ms2sato/agent-console/issues/905)).
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
