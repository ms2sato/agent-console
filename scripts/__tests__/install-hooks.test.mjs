import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = resolve(REPO_ROOT, 'scripts/install-hooks.mjs');
const SOURCE_HOOK = resolve(REPO_ROOT, 'scripts/git-hooks/commit-msg');

/**
 * Run install-hooks.mjs in a sandbox repo so the test never touches the
 * real .git/hooks directory. We bootstrap a minimal Git repo, copy our
 * source hook into a fixture path, and override GIT_DIR so that
 * `git rev-parse --git-path hooks` resolves inside the sandbox.
 */
function runInstaller(sandboxRoot, hookSource) {
  return spawnSync('bun', [INSTALL_SCRIPT], {
    encoding: 'utf8',
    cwd: sandboxRoot,
    env: {
      ...process.env,
      GIT_DIR: join(sandboxRoot, '.git'),
    },
  });
}

describe('scripts/install-hooks.mjs', () => {
  let sandbox;
  let hooksDir;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'install-hooks-'));
    // Make the sandbox look like a worktree of an existing repo: scripts/
    // dir with the hook source, and a .git directory we control.
    mkdirSync(join(sandbox, 'scripts/git-hooks'), { recursive: true });
    copyFileSync(SOURCE_HOOK, join(sandbox, 'scripts/git-hooks/commit-msg'));
    chmodSync(join(sandbox, 'scripts/git-hooks/commit-msg'), 0o755);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: sandbox });
    hooksDir = join(sandbox, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('fresh install creates a symlink to the source hook', () => {
    const result = runInstaller(sandbox);
    expect(result.status).toBe(0);
    const target = join(hooksDir, 'commit-msg');
    const stat = lstatSync(target);
    expect(stat.isSymbolicLink()).toBe(true);
    const link = readlinkSync(target);
    // realpath both sides because tmpdir() can resolve through /var → /private/var
    // on macOS while the script's `resolve()` keeps the unresolved form.
    expect(realpathSync(resolve(hooksDir, link))).toBe(
      realpathSync(resolve(sandbox, 'scripts/git-hooks/commit-msg')),
    );
  });

  it('re-running on a correct symlink is idempotent', () => {
    runInstaller(sandbox);
    const result = runInstaller(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already installed (symlink)');
  });

  it('refuses to overwrite a symlink pointing elsewhere', () => {
    const target = join(hooksDir, 'commit-msg');
    const otherFile = join(sandbox, 'somewhere-else');
    writeFileSync(otherFile, '#!/bin/sh\nexit 0\n');
    symlinkSync(otherFile, target);
    const result = runInstaller(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is a symlink to');
  });

  it('treats a same-content copy as already installed and normalizes mode (Major: CodeRabbit #725)', () => {
    // Pre-populate the hooks dir with a copy of our source content but at
    // mode 0644 — simulating a hand-edited install or a chmod -x mishap.
    const target = join(hooksDir, 'commit-msg');
    copyFileSync(join(sandbox, 'scripts/git-hooks/commit-msg'), target);
    chmodSync(target, 0o644);
    expect(lstatSync(target).mode & 0o111).toBe(0);

    const result = runInstaller(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already installed (copy)');

    // Mode must be normalized to executable so Git will run the hook.
    expect(lstatSync(target).mode & 0o100).not.toBe(0);
  });

  it('refuses to overwrite a regular file with different content', () => {
    const target = join(hooksDir, 'commit-msg');
    writeFileSync(target, '#!/bin/sh\necho different\n');
    chmodSync(target, 0o755);
    const result = runInstaller(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exists with different content');
  });

  it('errors with a clear message when the source hook is missing', () => {
    rmSync(join(sandbox, 'scripts/git-hooks/commit-msg'));
    const result = runInstaller(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source missing');
  });

  it('binds the symlink target to the main worktree, not cwd, when run from a linked worktree (Issue #728)', () => {
    // Reproduces the original bug: install was run from a linked worktree, so
    // `path.resolve(source)` (cwd-bound) embedded the worktree path into the
    // symlink target. Removing the worktree silently disabled the hook.
    const add = spawnSync('git', ['add', '.'], { cwd: sandbox, encoding: 'utf8' });
    expect(add.status).toBe(0);
    const commit = spawnSync(
      'git',
      [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=test',
        'commit',
        '-q',
        '-m',
        'init',
      ],
      { cwd: sandbox, encoding: 'utf8' },
    );
    expect(commit.status).toBe(0);

    // git worktree add wants the destination to not exist yet.
    const linkedWorktree = join(
      tmpdir(),
      `install-hooks-linked-${process.pid}-${Date.now()}`,
    );
    const addResult = spawnSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'wt-test-728', linkedWorktree],
      { cwd: sandbox, encoding: 'utf8' },
    );
    expect(addResult.status).toBe(0);

    try {
      // No GIT_DIR override — let git auto-detect via the linked worktree's
      // .git pointer file, exactly as in the real bug scenario.
      const result = spawnSync('bun', [INSTALL_SCRIPT], {
        encoding: 'utf8',
        cwd: linkedWorktree,
      });
      expect(result.status).toBe(0);

      // Hooks dir is the shared common dir at <sandbox>/.git/hooks.
      const target = join(hooksDir, 'commit-msg');
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      const link = readlinkSync(target);

      // The symlink target must NOT mention the linked worktree path —
      // that was the bug and the regression we are guarding against.
      expect(link).not.toContain(linkedWorktree);

      // Resolved, the symlink points to the main worktree's source.
      expect(realpathSync(resolve(hooksDir, link))).toBe(
        realpathSync(resolve(sandbox, 'scripts/git-hooks/commit-msg')),
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', linkedWorktree], {
        cwd: sandbox,
      });
      rmSync(linkedWorktree, { recursive: true, force: true });
    }
  });
});
