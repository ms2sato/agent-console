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

describe('scripts/install-hooks.mjs in a non-git environment (Issue #735, #1214)', () => {
  let nonGitSandbox;

  beforeEach(() => {
    nonGitSandbox = mkdtempSync(join(tmpdir(), 'install-hooks-nogit-'));
    // Mirror the repo's scripts/ tree so the postinstall command's
    // cwd-relative path `bun scripts/install-hooks.mjs` resolves inside
    // the sandbox the same way `bun install` would resolve it at the
    // repo root.
    mkdirSync(join(nonGitSandbox, 'scripts/git-hooks'), { recursive: true });
    copyFileSync(
      INSTALL_SCRIPT,
      join(nonGitSandbox, 'scripts/install-hooks.mjs'),
    );
    copyFileSync(
      SOURCE_HOOK,
      join(nonGitSandbox, 'scripts/git-hooks/commit-msg'),
    );
    chmodSync(join(nonGitSandbox, 'scripts/git-hooks/commit-msg'), 0o755);
  });

  afterEach(() => {
    rmSync(nonGitSandbox, { recursive: true, force: true });
  });

  // GIT_CEILING_DIRECTORIES stops git from walking up past the sandbox to
  // discover the real repo's .git that contains this test file. Without
  // it, `git rev-parse` succeeds on dev machines and the no-git scenario
  // is unreachable.
  function envWithCeiling() {
    return { ...process.env, GIT_CEILING_DIRECTORIES: nonGitSandbox };
  }

  it('install-hooks.mjs exits 0 with a stderr warning when no .git is reachable (Issue #1214)', () => {
    const result = spawnSync(
      'bun',
      [join(nonGitSandbox, 'scripts/install-hooks.mjs')],
      { encoding: 'utf8', cwd: nonGitSandbox, env: envWithCeiling() },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });

  it('package.json#scripts.postinstall exits 0 with no shell `||` needed when no .git is reachable (Issue #1214)', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const postinstallCmd = pkg.scripts.postinstall;
    expect(postinstallCmd).toBe('bun scripts/install-hooks.mjs');

    const result = spawnSync('sh', ['-c', postinstallCmd], {
      encoding: 'utf8',
      cwd: nonGitSandbox,
      env: envWithCeiling(),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });
});

describe('scripts/install-hooks.mjs hard-failure polarity (Issue #1214)', () => {
  // Guards against a future regression to "everything soft": failures that
  // occur AFTER git resolution succeeds must stay hard (non-zero exit).
  // These scenarios are already covered above (symlink-elsewhere, different
  // content, missing source) — this block exists to make the AC's mandatory
  // hard-path polarity requirement explicit and separately named so a future
  // reader sees it was intentionally verified, not just incidentally covered.
  let sandbox;
  let hooksDir;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'install-hooks-hardfail-'));
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

  it('a conflicting existing target still exits non-zero once git resolves', () => {
    const target = join(hooksDir, 'commit-msg');
    writeFileSync(target, '#!/bin/sh\necho different\n');
    chmodSync(target, 0o755);
    const result = runInstaller(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exists with different content');
  });

  it('a `git rev-parse --git-path hooks` failure stays hard (exit 1) even though the repo itself resolved', () => {
    // Stub `git` on PATH so `--git-common-dir` succeeds (as a real repo
    // would) but `--git-path hooks` fails, simulating a corrupted /
    // abnormal repo state distinct from "no git repo at all". Only
    // resolveRepoRoot()'s git-absence branch is soft; a hooks-path failure
    // AFTER the repo resolves must surface loudly, not be swallowed as if
    // the repo were simply missing (that would silently skip installing
    // the commit-msg language check — the #1210 silent-no-op class).
    const stubBin = mkdtempSync(join(tmpdir(), 'install-hooks-stubgit-'));
    const gitStub = join(stubBin, 'git');
    writeFileSync(
      gitStub,
      [
        '#!/bin/sh',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
        '  echo "/tmp/fake-common-dir"',
        '  exit 0',
        'fi',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ]; then',
        '  echo "simulated corrupted repo" 1>&2',
        '  exit 1',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(gitStub, 0o755);

    try {
      const result = spawnSync('bun', [INSTALL_SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('git rev-parse --git-path hooks');
    } finally {
      rmSync(stubBin, { recursive: true, force: true });
    }
  });
});

describe('scripts/install-hooks.mjs invoked via package.json#postinstall in a git repo (Issue #735)', () => {
  let sandbox;
  let hooksDir;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'install-hooks-postinstall-'));
    mkdirSync(join(sandbox, 'scripts/git-hooks'), { recursive: true });
    copyFileSync(INSTALL_SCRIPT, join(sandbox, 'scripts/install-hooks.mjs'));
    copyFileSync(SOURCE_HOOK, join(sandbox, 'scripts/git-hooks/commit-msg'));
    chmodSync(join(sandbox, 'scripts/git-hooks/commit-msg'), 0o755);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: sandbox });
    hooksDir = join(sandbox, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('running the postinstall command string installs the symlink (mirrors `bun install` behavior)', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const postinstallCmd = pkg.scripts.postinstall;

    const result = spawnSync('sh', ['-c', postinstallCmd], {
      encoding: 'utf8',
      cwd: sandbox,
      env: { ...process.env, GIT_DIR: join(sandbox, '.git') },
    });
    expect(result.status).toBe(0);
    const target = join(hooksDir, 'commit-msg');
    const stat = lstatSync(target);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(realpathSync(resolve(hooksDir, readlinkSync(target)))).toBe(
      realpathSync(resolve(sandbox, 'scripts/git-hooks/commit-msg')),
    );
  });
});
