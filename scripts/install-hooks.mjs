#!/usr/bin/env bun

/**
 * Install Git hooks defined under scripts/git-hooks/ into the repository's
 * hooks directory. Currently installs only `commit-msg` (the language check).
 *
 * Idempotent — safe to re-run. Resolves the hooks directory via
 * `git rev-parse --git-path hooks` so it works correctly inside linked
 * worktrees (which share the common dir's hooks/).
 *
 * Installation strategy: symlink first, copy on failure — some filesystems
 * / sandboxes reject symlink creation, so a real-file copy is the fallback
 * rather than a hard failure. If the target already exists and matches our
 * source (symlink target identical, or file content identical), the
 * script reports "already installed" and exits 0. If it exists with
 * different content, the script refuses to overwrite and asks the user to
 * remove it explicitly.
 *
 * Soft-fail ownership: when no git repository is resolvable at
 * all (`git rev-parse --git-common-dir` fails — no `.git`, e.g. a Docker bind
 * mount of a worktree without its main repo, or a non-git checkout), this
 * script exits 0 with a stderr warning rather than exit 1. This is the same
 * fact regardless of invocation context (postinstall or a manual
 * `bun run hooks:install`), so the exit-0 contract lives here rather than in
 * a shell `||` fallback at the call site — a shell `cmdA || cmdB` postinstall
 * string was found to not reliably surface its final exit status through Bun
 * 1.3.8's lifecycle-script bookkeeping.
 *
 * This soft-fail is intentionally asymmetric: only `resolveRepoRoot()`'s
 * `--git-common-dir` failure is soft. `resolveHooksDir()`'s
 * `--git-path hooks` failure — which only runs after a repo was already
 * found — stays a hard failure, because at that point "no repo" has already
 * been ruled out; the failure means something is abnormal (a corrupted repo,
 * a git internal error) that should surface loudly rather than silently skip
 * installing the commit-msg language check (the same silent-no-op class as
 * #1210). Likewise, failures after both resolve (symlink failure, copy
 * failure, conflicting existing target) stay hard failures — those mean the
 * hook genuinely didn't install.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HOOKS = [{ name: 'commit-msg', source: 'scripts/git-hooks/commit-msg' }];

function resolveRepoRoot() {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('hooks:install — not a git repository; skipping hook install.');
    console.error(`\`git rev-parse --git-common-dir\` failed: ${result.stderr || '(no stderr)'}`);
    return null;
  }
  // `.git` (relative) when run from the main worktree, absolute path to the
  // shared `.git` when run from a linked worktree. Either way the parent
  // directory is the main worktree root, which is the stable location that
  // owns scripts/git-hooks/.
  return dirname(resolve(result.stdout.trim()));
}

function resolveHooksDir() {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // Reached only after resolveRepoRoot() already confirmed a git repo
    // exists, so this is NOT the "no git repo" case — it stays a hard
    // failure (see the module docstring for why).
    console.error(
      'hooks:install — `git rev-parse --git-path hooks` failed even though a git repository was found:',
    );
    console.error(result.stderr || '(no stderr)');
    process.exit(1);
  }
  return resolve(result.stdout.trim());
}

function installOne({ name, source }, hooksDir, repoRoot) {
  // Resolve the source against the main worktree root rather than cwd:
  // `resolve(source)` alone is cwd-bound, so running from a linked
  // worktree would embed that ephemeral worktree's path into the symlink
  // target, silently disabling the hook once the worktree was removed.
  const sourceAbs = join(repoRoot, source);
  if (!existsSync(sourceAbs)) {
    console.error(`hooks:install — source missing: ${sourceAbs}`);
    process.exit(1);
  }
  const target = join(hooksDir, name);
  const stat = lstatSync(target, { throwIfNoEntry: false });

  if (stat) {
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(target);
      const linkAbs = resolve(hooksDir, link);
      if (linkAbs === sourceAbs) {
        console.log(`hooks:install — already installed (symlink): ${target}`);
        return;
      }
      console.error(
        `hooks:install — ${target} is a symlink to ${linkAbs}, not ${sourceAbs}.`,
      );
      console.error(`Remove it manually and re-run: rm "${target}"`);
      process.exit(1);
    }
    if (stat.isFile()) {
      const sourceContent = readFileSync(sourceAbs, 'utf8');
      const targetContent = readFileSync(target, 'utf8');
      if (sourceContent === targetContent) {
        // Normalize the executable bit. Git ignores hooks that are not
        // executable (e.g., the file was edited and re-saved with mode
        // 0644), and the same-content shortcut would otherwise leave that
        // broken state in place.
        chmodSync(target, 0o755);
        console.log(`hooks:install — already installed (copy): ${target}`);
        return;
      }
      console.error(
        `hooks:install — ${target} exists with different content.`,
      );
      console.error(`Remove it manually and re-run: rm "${target}"`);
      process.exit(1);
    }
    console.error(
      `hooks:install — ${target} exists and is neither a symlink nor a regular file.`,
    );
    process.exit(1);
  }

  try {
    symlinkSync(sourceAbs, target);
    console.log(`hooks:install — symlinked ${target} -> ${sourceAbs}`);
    return;
  } catch (err) {
    console.warn(
      `hooks:install — symlink failed (${err?.code || err?.message || 'unknown'}), falling back to copy.`,
    );
  }
  copyFileSync(sourceAbs, target);
  chmodSync(target, 0o755);
  console.log(`hooks:install — copied ${source} -> ${target}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  if (repoRoot === null) {
    process.exit(0);
  }
  const hooksDir = resolveHooksDir();
  mkdirSync(hooksDir, { recursive: true });
  for (const hook of HOOKS) installOne(hook, hooksDir, repoRoot);
}

main();
