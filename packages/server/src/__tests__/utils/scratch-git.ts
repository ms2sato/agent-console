/**
 * Creates a hermetic scratch git repository for tests and smokes that need
 * to commit inside a throwaway repo. Without this helper, a scratch repo
 * inherits the operator's global git config (signing program, hooksPath,
 * defaultBranch, aliases) via the normal git config resolution chain, so its
 * outcome silently depends on host state the test never declared -- see
 * `os-environment-coupling.md`.
 *
 * The helper writes its own throwaway global config and points
 * `GIT_CONFIG_GLOBAL` at it instead of touching `git config --global` or the
 * operator's real `~/.gitconfig`. Two structural guards make it impossible to
 * aim this at anything but a directory the helper itself just created under a
 * temp root -- see `assertParentDirAllowed` below. Both guards resolve
 * symlinks (via the nearest-existing-ancestor `realpath` walk in
 * `resolveRealish`) before comparing, on both sides of every comparison --
 * without that, a symlink under `os.tmpdir()` pointing INTO the real
 * repository would satisfy guard (i) and defeat guard (ii) entirely
 * (CodeRabbit review, PR #1814).
 */
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ScratchGitRepo {
  /** The scratch repository's working directory. */
  dir: string;
  /** Env carrying the scratch `GIT_CONFIG_GLOBAL` override. Spread this into any spawn that must run inside `dir` outside of `git()` -- never at a different `cwd`; the helper's guards protect where the repository was CREATED, not how this env is subsequently used. */
  env: Record<string, string>;
  /** Runs `git <args>` with `cwd` fixed to `dir` and this repo's scratch env. Returns trimmed stdout; throws (with stderr) on non-zero exit. */
  git(args: string[]): Promise<string>;
  /** Removes the scratch repository directory and its associated scratch config/hooks dir. */
  cleanup(): Promise<void>;
}

export interface CreateScratchGitRepoOptions {
  /** Directory the scratch repo is created under (via `mkdtemp` -- never an existing repository). */
  parentDir: string;
  /** Optional `mkdtemp` prefix; defaults to `scratch-git-`. */
  name?: string;
  /** Whether to create an initial empty commit. Defaults to `true`. */
  initialCommit?: boolean;
  /**
   * An additional root, alongside `os.tmpdir()`, under which `parentDir` may
   * resolve. For smokes whose disposable `AGENT_CONSOLE_HOME` lives outside
   * the OS temp dir (e.g. under `$HOME/.agent-console-smoke-*`).
   */
  allowRoot?: string;
}

const REAL_REPOSITORY_RULE =
  'scratch git config is never applied inside the real repository';

/**
 * Git repository-location variables. `GIT_CONFIG_GLOBAL` does not override
 * any of these -- an inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
 * can redirect a git command onto a completely different repository's
 * state, regardless of which global config file is in effect.
 */
const RISKY_GIT_LOCATION_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
]);

/**
 * Git command-scope configuration-injection variables. `GIT_CONFIG_COUNT` +
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` is a SEPARATE, higher-precedence
 * mechanism from `GIT_CONFIG_GLOBAL` (per git's own docs: these env pairs
 * "override values in configuration files"), so an inherited triple can
 * re-enable `commit.gpgsign` or set `core.hooksPath` regardless of the
 * scratch config this helper writes. `GIT_CONFIG` / `GIT_CONFIG_PARAMETERS`
 * are the older single-value forms of the same hazard.
 */
const RISKY_GIT_CONFIG_INJECTION_KEYS = new Set(['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);

function isRiskyGitConfigInjectionKeyPrefix(key: string): boolean {
  return key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_');
}

/**
 * Returns a copy of `sourceEnv` with git repository-location and
 * command-scope configuration-injection variables removed. Deliberately
 * narrow: only the git namespace above is touched. `HOME`, `PATH`,
 * `SSH_AUTH_SOCK`, and everything else the caller's environment needs stay
 * untouched -- this helper's job is hermetic git config and repository
 * location, not a clean environment in general.
 *
 * Exported so callers that need to demonstrate the "without this helper"
 * case (e.g. the sibling test's polarity spawn) can still isolate their
 * comparison from ambient git-namespace noise without duplicating this
 * list. `install-hooks.test.mjs` (plain Node, cannot import this module)
 * duplicates the same key list inline with a comment naming this function
 * as the single writer of the canonical version.
 */
export function sanitizeInheritedGitEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (RISKY_GIT_LOCATION_KEYS.has(key)) continue;
    if (RISKY_GIT_CONFIG_INJECTION_KEYS.has(key)) continue;
    if (isRiskyGitConfigInjectionKeyPrefix(key)) continue;
    result[key] = value;
  }
  return result;
}

/** True when `candidate` is `root` itself or a descendant of it, comparing resolved absolute paths. */
function isUnder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves `candidate` to a real (symlink-free) absolute path, even when
 * `candidate` (or a trailing portion of it) does not exist yet -- `mkdtemp`'s
 * target never exists before this helper creates it. Splits `candidate`
 * into its longest EXISTING ancestor plus the non-existent remainder,
 * `realpath`s the ancestor only, then re-joins the remainder literally
 * (the remainder cannot itself be a symlink, since nothing has been created
 * there yet). This also resolves a symlinked `os.tmpdir()` itself (e.g.
 * macOS's `/var` -> `/private/var`), so both sides of every guard
 * comparison are on equal footing.
 */
async function resolveRealish(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const remainder: string[] = [];
  while (true) {
    try {
      await stat(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
  let realBase: string;
  try {
    realBase = await realpath(current);
  } catch {
    realBase = current;
  }
  return remainder.length > 0 ? path.join(realBase, ...remainder) : realBase;
}

/**
 * Resolves the toplevel of the git repository that contains `process.cwd()`,
 * or `null` when `process.cwd()` is not inside a git repository. Run inside a
 * linked worktree, `git rev-parse --show-toplevel` returns that worktree's
 * own toplevel, not the main checkout's -- which is the directory this guard
 * is meant to protect.
 */
async function resolveCwdRepoToplevel(): Promise<string | null> {
  // Sanitized for the same reason `createScratchGitRepo`'s own env is: an
  // ambient `GIT_DIR` (with no `GIT_WORK_TREE`) makes git skip repository
  // discovery entirely and treat `cwd` itself as the toplevel, which would
  // silently corrupt guard (ii)'s reference point -- the very check this
  // function exists to answer.
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    env: sanitizeInheritedGitEnv(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}

/**
 * Throws before anything is created when `parentDir` is not a safe location
 * for a scratch git repository. Two independent checks, both must pass:
 * (i) `parentDir` resolves under `os.tmpdir()` or the explicit `allowRoot`;
 * (ii) `parentDir` does not resolve inside the toplevel of the repository
 * containing `process.cwd()` (checked unconditionally, even when `allowRoot`
 * permits the path -- guard (i) and guard (ii) are independent).
 *
 * Every path on both sides of both comparisons is resolved through
 * `resolveRealish` first, so a symlink can never be used to make a path
 * that lives inside the real repository LOOK like it resolves under
 * `os.tmpdir()` (or vice versa). Returns the resolved form of `parentDir`
 * so the caller creates the repository at the SAME path this function just
 * validated, rather than re-deriving it (and potentially re-following a
 * symlink) a second time.
 */
async function assertParentDirAllowed(parentDir: string, allowRoot: string | undefined): Promise<string> {
  const resolvedParent = await resolveRealish(parentDir);
  const resolvedTmp = await resolveRealish(os.tmpdir());
  const resolvedAllowRoot = allowRoot !== undefined ? await resolveRealish(allowRoot) : undefined;

  const underTmp = isUnder(resolvedParent, resolvedTmp);
  const underAllowRoot = resolvedAllowRoot !== undefined && isUnder(resolvedParent, resolvedAllowRoot);
  if (!underTmp && !underAllowRoot) {
    throw new Error(
      `${REAL_REPOSITORY_RULE}: parentDir "${parentDir}" must resolve under os.tmpdir() ` +
        `("${os.tmpdir()}") or an explicitly passed allowRoot`,
    );
  }

  const cwdToplevel = await resolveCwdRepoToplevel();
  const resolvedCwdToplevel = cwdToplevel !== null ? await resolveRealish(cwdToplevel) : null;
  if (resolvedCwdToplevel !== null && isUnder(resolvedParent, resolvedCwdToplevel)) {
    throw new Error(
      `${REAL_REPOSITORY_RULE}: parentDir "${parentDir}" resolves inside the toplevel of the ` +
        `repository containing process.cwd() ("${cwdToplevel}")`,
    );
  }

  return resolvedParent;
}

async function runGit(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${stderr}`);
  }
  return stdout.trim();
}

export async function createScratchGitRepo(opts: CreateScratchGitRepoOptions): Promise<ScratchGitRepo> {
  const { parentDir, name, initialCommit = true, allowRoot } = opts;

  const resolvedParentDir = await assertParentDirAllowed(parentDir, allowRoot);

  await mkdir(resolvedParentDir, { recursive: true });
  const dir = await mkdtemp(path.join(resolvedParentDir, name ?? 'scratch-git-'));
  const basename = path.basename(dir);

  const hooksDir = path.join(resolvedParentDir, `${basename}-hooks-empty`);
  await mkdir(hooksDir, { recursive: true });

  const configPath = path.join(resolvedParentDir, `${basename}.gitconfig`);
  const configContents = [
    '[user]',
    '\tname = Scratch',
    '\temail = scratch@example.com',
    '[commit]',
    '\tgpgsign = false',
    '[init]',
    '\tdefaultBranch = main',
    '[core]',
    `\thooksPath = ${hooksDir}`,
    '',
  ].join('\n');
  await writeFile(configPath, configContents, 'utf-8');

  const env: Record<string, string> = {
    ...sanitizeInheritedGitEnv(process.env),
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
  };

  async function git(args: string[]): Promise<string> {
    return runGit(args, dir, env);
  }

  await git(['init', '-q']);
  if (initialCommit) {
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
  }

  async function cleanup(): Promise<void> {
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(hooksDir, { recursive: true, force: true }),
      rm(configPath, { force: true }),
    ]);
  }

  return { dir, env, git, cleanup };
}
