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
 * Duplicated inline from `packages/server/src/__tests__/utils/scratch-git.ts`'s
 * `sanitizeInheritedGitEnv` (the single writer of the canonical, TS-importable
 * version) -- this file is plain Node (.mjs) and cannot import it. Strips git
 * repository-location and command-scope configuration-injection variables
 * before the one commit spawn below that also sets GIT_CONFIG_GLOBAL: none of
 * these are overridden by GIT_CONFIG_GLOBAL (a separate, higher-precedence
 * mechanism per git's own docs), so an inherited GIT_CONFIG_COUNT triple could
 * re-enable commit signing, and an inherited GIT_DIR/GIT_WORK_TREE/
 * GIT_INDEX_FILE could redirect the commit onto different repository state
 * entirely (CodeRabbit review, PR #1814). Deliberately narrow: only the git
 * namespace is touched, never HOME/PATH/SSH_AUTH_SOCK/etc.
 */
function sanitizeInheritedGitEnv(sourceEnv) {
  const riskyKeys = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_QUARANTINE_PATH',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ]);
  const result = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (riskyKeys.has(key)) continue;
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) continue;
    result[key] = value;
  }
  return result;
}

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

    // Hermetic commit env, inline: this file is plain Node (.mjs) and
    // cannot import the TypeScript `createScratchGitRepo` helper
    // (packages/server/src/__tests__/utils/scratch-git.ts is the single
    // writer of that pattern for TS-importable callers). GIT_CONFIG_GLOBAL
    // replaces the whole global config layer for this one commit so a
    // host with commit signing enabled (gpgsign, gpg.ssh.program) does not
    // fail this spawn before the behavior under test is ever reached --
    // never `git config --global` and never touching the real
    // ~/.gitconfig.
    const noSignConfigPath = join(sandbox, '.no-sign.gitconfig');
    writeFileSync(noSignConfigPath, '[commit]\n\tgpgsign = false\n');
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
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...sanitizeInheritedGitEnv(process.env),
          GIT_CONFIG_GLOBAL: noSignConfigPath,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
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
        'if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--is-bare-repository" ]; then',
        '  echo "false"',
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

  it('a `git rev-parse --is-bare-repository` failure after the repo resolved stays hard (exit 1), same asymmetry', () => {
    // Same stub shape as above, but now the bare probe fails: the repository
    // was found, so this is an abnormal state, not "no git repo", and must not
    // be swallowed (it would otherwise pick a wrong install mode silently).
    const stubBin = mkdtempSync(join(tmpdir(), 'install-hooks-stubgit-bare-'));
    const gitStub = join(stubBin, 'git');
    writeFileSync(
      gitStub,
      [
        '#!/bin/sh',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
        '  echo "/tmp/fake-common-dir"',
        '  exit 0',
        'fi',
        'echo "simulated failure" 1>&2',
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
      expect(result.stderr).toContain('git rev-parse --is-bare-repository');
      expect(result.stderr).toContain('simulated failure');
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

describe('scripts/install-hooks.mjs on a bare repository (Issue #2091)', () => {
  // Fixture: a scratch non-bare repo that contains the hook source AND a copy of
  // install-hooks.mjs (so `import.meta.dirname` is the checkout the script runs
  // from, exactly as in a real worktree), a `git clone --bare` of it, and a
  // detached linked worktree of the bare clone. Hermetic commit env, inline, for
  // the same reason as the linked-worktree case above.
  //
  // Mutations measured when this block was written (each restored):
  // - detecting bareness via the cwd instead of the common dir -> (a), (b), (d)
  //   fail (exit 1, "source missing" with the bare dir's parent in the path)
  //   and so does (c)'s source-shape assertion; (c)'s git-behaviour assertions
  //   do NOT depend on the script (they pin the facts the rule relies on);
  // - allowing the symlink attempt on a bare repo -> (a), (b), (d) fail (the
  //   hook would be a symlink to the ephemeral worktree).
  let root;
  let source; // scratch non-bare repo
  let bare; // git clone --bare of `source`
  let wt; // detached linked worktree of `bare`

  const hermeticGit = (args, cwd) => {
    const noSignConfigPath = join(root, '.no-sign.gitconfig');
    writeFileSync(noSignConfigPath, '[commit]\n\tgpgsign = false\n');
    return spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...sanitizeInheritedGitEnv(process.env),
        GIT_CONFIG_GLOBAL: noSignConfigPath,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  };

  const bareFlag = (cwd) =>
    spawnSync('git', ['rev-parse', '--is-bare-repository'], {
      cwd,
      encoding: 'utf8',
      env: sanitizeInheritedGitEnv(process.env),
    }).stdout.trim();

  const runIn = (cwd) =>
    spawnSync('bun', [join(cwd, 'scripts/install-hooks.mjs')], {
      encoding: 'utf8',
      cwd,
      env: sanitizeInheritedGitEnv(process.env),
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'install-hooks-bare-'));
    source = join(root, 'source');
    mkdirSync(join(source, 'scripts/git-hooks'), { recursive: true });
    copyFileSync(SOURCE_HOOK, join(source, 'scripts/git-hooks/commit-msg'));
    chmodSync(join(source, 'scripts/git-hooks/commit-msg'), 0o755);
    copyFileSync(INSTALL_SCRIPT, join(source, 'scripts/install-hooks.mjs'));
    expect(hermeticGit(['init', '-q', '-b', 'main'], source).status).toBe(0);
    expect(hermeticGit(['add', '.'], source).status).toBe(0);
    expect(hermeticGit(['commit', '-q', '-m', 'init'], source).status).toBe(0);
    bare = join(root, 'bare.git');
    expect(hermeticGit(['clone', '-q', '--bare', source, bare], root).status).toBe(0);
    wt = join(root, 'wt');
    expect(hermeticGit(['worktree', 'add', '-q', '--detach', wt, 'HEAD'], bare).status).toBe(0);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('(a) installs by COPY into the bare repository\'s hooks dir: a regular file, equal content, mode 0755', () => {
    const result = runIn(wt);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hooks:install — copied');

    const target = join(bare, 'hooks', 'commit-msg');
    const stat = lstatSync(target);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(join(wt, 'scripts/git-hooks/commit-msg'), 'utf8'));
    expect(stat.mode & 0o777).toBe(0o755);
  });

  it('(b) a re-run exits 0 and reports "already installed (copy)"', () => {
    expect(runIn(wt).status).toBe(0);
    const again = runIn(wt);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already installed (copy)');
  });

  it('(c) detection-site pin: the cwd form says false inside the linked worktree, the common-dir form says true, and the hooks path is the bare dir\'s', () => {
    // These two outputs are WHY the script must ask the common dir: a future
    // "simplification" to the cwd form would read `false` here and mistake the
    // worktree for a non-bare checkout.
    expect(bareFlag(wt)).toBe('false');
    expect(bareFlag(bare)).toBe('true');
    const hooksPath = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: wt,
      encoding: 'utf8',
      env: sanitizeInheritedGitEnv(process.env),
    }).stdout.trim();
    expect(realpathSync(resolve(wt, hooksPath))).toBe(realpathSync(join(bare, 'hooks')));

    // And the script must really ask the common dir: the one assertion in this
    // test that reads the script. It pins the detection site so replacing the
    // `-C <common-dir>` form with the cwd form fails here, not only in (a).
    expect(readFileSync(INSTALL_SCRIPT, 'utf8')).toContain(
      "['-C', commonDirAbs, 'rev-parse', '--is-bare-repository']",
    );
  });

  it('(d) the postinstall command string from package.json exits 0 in the linked worktree', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const result = spawnSync('sh', ['-c', pkg.scripts.postinstall], {
      encoding: 'utf8',
      cwd: wt,
      env: sanitizeInheritedGitEnv(process.env),
    });
    // The real postinstall is a chain; only its install-hooks step is under
    // test here, and it must not be the part that fails.
    expect(result.stderr).not.toContain('source missing');
    expect(result.status).toBe(0);
    expect(lstatSync(join(bare, 'hooks', 'commit-msg')).isFile()).toBe(true);
  });

  it('(e) non-bare control: a linked worktree of a NON-bare repo still gets a SYMLINK bound to the main worktree', () => {
    const nonBareWt = join(root, 'nb-wt');
    expect(hermeticGit(['worktree', 'add', '-q', '--detach', nonBareWt, 'HEAD'], source).status).toBe(0);
    const result = runIn(nonBareWt);
    expect(result.status).toBe(0);

    const target = join(source, '.git', 'hooks', 'commit-msg');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    const link = readlinkSync(target);
    expect(link).not.toContain(nonBareWt);
    expect(realpathSync(resolve(dirname(target), link))).toBe(
      realpathSync(join(source, 'scripts/git-hooks/commit-msg')),
    );
  });
});
