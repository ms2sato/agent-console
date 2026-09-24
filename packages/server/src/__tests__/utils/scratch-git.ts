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
 * temp root -- see `assertParentDirAllowed` below.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ScratchGitRepo {
  /** The scratch repository's working directory. */
  dir: string;
  /** Env carrying the scratch `GIT_CONFIG_GLOBAL` override. Spread this into any spawn that must run inside `dir` outside of `git()`. */
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

/** True when `candidate` is `root` itself or a descendant of it, comparing resolved absolute paths. */
function isUnder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves the toplevel of the git repository that contains `process.cwd()`,
 * or `null` when `process.cwd()` is not inside a git repository. Run inside a
 * linked worktree, `git rev-parse --show-toplevel` returns that worktree's
 * own toplevel, not the main checkout's -- which is the directory this guard
 * is meant to protect.
 */
async function resolveCwdRepoToplevel(): Promise<string | null> {
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
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
 */
async function assertParentDirAllowed(parentDir: string, allowRoot: string | undefined): Promise<void> {
  const resolvedParent = path.resolve(parentDir);

  const underTmp = isUnder(resolvedParent, path.resolve(os.tmpdir()));
  const underAllowRoot = allowRoot !== undefined && isUnder(resolvedParent, path.resolve(allowRoot));
  if (!underTmp && !underAllowRoot) {
    throw new Error(
      `${REAL_REPOSITORY_RULE}: parentDir "${parentDir}" must resolve under os.tmpdir() ` +
        `("${os.tmpdir()}") or an explicitly passed allowRoot`,
    );
  }

  const cwdToplevel = await resolveCwdRepoToplevel();
  if (cwdToplevel !== null && isUnder(resolvedParent, path.resolve(cwdToplevel))) {
    throw new Error(
      `${REAL_REPOSITORY_RULE}: parentDir "${parentDir}" resolves inside the toplevel of the ` +
        `repository containing process.cwd() ("${cwdToplevel}")`,
    );
  }
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

  await assertParentDirAllowed(parentDir, allowRoot);

  await mkdir(parentDir, { recursive: true });
  const dir = await mkdtemp(path.join(parentDir, name ?? 'scratch-git-'));
  const basename = path.basename(dir);

  const hooksDir = path.join(parentDir, `${basename}-hooks-empty`);
  await mkdir(hooksDir, { recursive: true });

  const configPath = path.join(parentDir, `${basename}.gitconfig`);
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
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.GIT_CONFIG_PARAMETERS;

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
