import * as path from 'path';

/**
 * The value `{{REPO}}` resolves to in setup / cleanup / pause / resume
 * commands and repository envVars: the directory name of the registered
 * checkout. Single writer for every site that fills the `repo` template
 * variable.
 *
 * Deliberately NOT the repository's display `name`: that is a mutable
 * free-text label (see `RepositoryDisplayNameSchema`), so reading it here would
 * change what an existing worktree's cleanup / pause / resume command and
 * env vars resolve to after a rename. `path` has no update path, so this value
 * is stable for the life of the registration (and equals what `name` held
 * before display-name editing existed).
 */
export function resolveRepoTemplateName(repositoryPath: string): string {
  return path.basename(repositoryPath);
}
