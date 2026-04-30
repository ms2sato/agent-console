#!/usr/bin/env bun

/**
 * Install Git hooks defined under scripts/git-hooks/ into the repository's
 * hooks directory. Currently installs only `commit-msg` (the language check).
 *
 * Idempotent — safe to re-run. Resolves the hooks directory via
 * `git rev-parse --git-path hooks` so it works correctly inside linked
 * worktrees (which share the common dir's hooks/).
 *
 * Installation strategy: symlink first, copy on failure (per Issue #719).
 * If the target already exists and matches our source (symlink target
 * identical, or file content identical), the script reports "already
 * installed" and exits 0. If it exists with different content, the script
 * refuses to overwrite and asks the user to remove it explicitly.
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
import { join, resolve } from 'node:path';

const HOOKS = [{ name: 'commit-msg', source: 'scripts/git-hooks/commit-msg' }];

function resolveHooksDir() {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('hooks:install — `git rev-parse --git-path hooks` failed:');
    console.error(result.stderr || '(no stderr)');
    process.exit(1);
  }
  return resolve(result.stdout.trim());
}

function installOne({ name, source }, hooksDir) {
  const sourceAbs = resolve(source);
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
  const hooksDir = resolveHooksDir();
  mkdirSync(hooksDir, { recursive: true });
  for (const hook of HOOKS) installOne(hook, hooksDir);
}

main();
