/**
 * This suite uses the REAL fs (never `mock-fs-helper`): the helper under
 * test spawns the real `git` binary against directories memfs cannot make
 * visible to a subprocess, and the polarity case must prove itself against
 * a REAL fake host config. `HOME` is pointed at a scratch home for the
 * whole file so the operator's real `~/.gitconfig` is never read or
 * written. Per `testing.md`'s real-fs test placement rule, this file runs
 * in `packages/server`'s second `bun test` invocation (`package.json`) and
 * calls `assertRealFs` before any other fs call, rather than silently
 * risking memfs poisoning from an earlier-loaded file in a shared process.
 *
 * Mutation record (workflow.md "A check's existence is not its detection
 * power"), all measured against this file during implementation:
 *   - Removing `GIT_CONFIG_GLOBAL` from the env `createScratchGitRepo`
 *     returns -> the POLARITY test fails (the helper-routed commit then
 *     also fails on the fake host signer).
 *   - Removing guard (ii)'s toplevel check -> the "guard (ii)" test fails
 *     (no throw, and a stray directory would appear under the real
 *     repository's toplevel).
 *   - Removing `sanitizeInheritedGitEnv`'s call site (raw `...process.env`
 *     instead) -> the "GIT_CONFIG_COUNT/KEY/VALUE injection" test fails with
 *     the EXACT `cannot exec '/nonexistent/op-ssh-sign'` error the POLARITY
 *     test's withoutHelperEnv spawn produces (CodeRabbit review, PR #1814).
 *   - Removing `'GIT_DIR'` from `RISKY_GIT_LOCATION_KEYS` -> the "inherited
 *     GIT_DIR" test fails: the commit lands in the OTHER scratch repo
 *     (`rev-list --count HEAD` goes from 1 to 2) and `rev-parse --git-dir`
 *     reports the other repo's `.git`, not this repo's own.
 *   - Reverting `resolveRealish` to plain `path.resolve` (no symlink
 *     resolution) -> the "symlinked parentDir" guard-(ii) test fails (no
 *     throw); the scratch repo is actually created inside the real
 *     repository's toplevel through the symlink, cleaned up by the test's
 *     own `finally` regardless.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertRealFs } from '../memfs-detection.js';
import { createScratchGitRepo } from '../scratch-git.js';

// Guard (i) and guard (ii) share an invariant-naming prefix ("scratch git
// config is never applied inside the real repository") but differ in their
// specific wording, so a test can assert which guard fired rather than
// merely that "some" guard threw.
const GUARD_I_MESSAGE = /must resolve under os\.tmpdir\(\)/;
const GUARD_II_MESSAGE = /resolves inside the toplevel of the repository containing process\.cwd\(\)/;

const originalHome = process.env.HOME;
const originalTmpdir = process.env.TMPDIR;

let scratchHome: string;
let fakeHostConfigPath: string;
let fakeHostConfigSnapshot: { mtimeMs: number; content: string };
let scratchParent: string;

beforeAll(async () => {
  await assertRealFs('scratch-git.test.ts setup');
  scratchHome = await mkdtemp(path.join(os.tmpdir(), 'scratch-git-test-home-'));
  fakeHostConfigPath = path.join(scratchHome, '.gitconfig');
  await writeFile(
    fakeHostConfigPath,
    [
      '[user]',
      '\tname = Fake Host User',
      '\temail = fake-host-user@example.com',
      '\tsigningkey = /fake/path/to/ssh-signing-key.pub',
      '[commit]',
      '\tgpgsign = true',
      '[gpg]',
      '\tformat = ssh',
      '[gpg "ssh"]',
      '\tprogram = /nonexistent/op-ssh-sign',
      '',
    ].join('\n'),
    'utf-8',
  );
  const snapshotStat = await stat(fakeHostConfigPath);
  fakeHostConfigSnapshot = {
    mtimeMs: snapshotStat.mtimeMs,
    content: await readFile(fakeHostConfigPath, 'utf-8'),
  };

  // Point HOME at the scratch home for the whole file -- the operator's real
  // ~/.gitconfig must never be consulted by any test below.
  process.env.HOME = scratchHome;

  scratchParent = await mkdtemp(path.join(os.tmpdir(), 'scratch-git-test-parent-'));
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(scratchHome, { recursive: true, force: true });
  await rm(scratchParent, { recursive: true, force: true });
});

afterEach(() => {
  // Guard-(i) tests below reassign TMPDIR to redefine what os.tmpdir()
  // returns for that one test; restore it unconditionally so later tests in
  // this file (and any file sharing this process) see the real value.
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
});

describe('createScratchGitRepo', () => {
  it('POLARITY: a commit without the helper env fails on the fake host signer; the same commit through repo.git succeeds', async () => {
    const repo = await createScratchGitRepo({ parentDir: scratchParent, initialCommit: false });

    // Without the helper's env: this spawn inherits `process.env`, whose
    // HOME points at the fake host config -- commit.gpgsign=true routes
    // through the nonexistent gpg.ssh.program and fails INSIDE the signer
    // invocation (not on earlier config validation; a signingkey is set).
    const withoutHelperEnv = Bun.spawn(['git', 'commit', '--allow-empty', '-q', '-m', 'no-helper-env'], {
      cwd: repo.dir,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await withoutHelperEnv.exited;
    const stderr = await new Response(withoutHelperEnv.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('cannot exec');
    expect(stderr).toContain('/nonexistent/op-ssh-sign');

    // Through the helper's own env: GIT_CONFIG_GLOBAL replaces the whole
    // global config layer, so the fake host config -- and its broken
    // signer -- is never consulted.
    const result = await repo.git(['commit', '--allow-empty', '-q', '-m', 'via-helper']);
    expect(typeof result).toBe('string');

    await repo.cleanup();
  });

  it('git config --list --show-origin shows no origin under the fake host config and no commit.gpgsign=true', async () => {
    const repo = await createScratchGitRepo({ parentDir: scratchParent });
    const output = await repo.git(['config', '--list', '--show-origin']);
    expect(output).not.toContain(scratchHome);
    expect(output).not.toContain('commit.gpgsign=true');
    await repo.cleanup();
  });

  it('guard (i): parentDir outside os.tmpdir() with no allowRoot throws before creating anything', async () => {
    // Redefine os.tmpdir() (via TMPDIR, which Bun's os.tmpdir() re-reads on
    // every call) to a fresh scratch root, then target a sibling directory
    // that is outside that redefined tmpdir but still lives under the REAL
    // /tmp -- isolates guard (i) without needing to write outside tmp or
    // touch the real repository.
    const fakeTmpRoot = await mkdtemp(path.join(os.tmpdir(), 'scratch-git-test-faketmp-'));
    const outsideFakeTmp = path.join(path.dirname(fakeTmpRoot), 'scratch-git-test-outside-faketmp');
    process.env.TMPDIR = fakeTmpRoot;

    try {
      await expect(createScratchGitRepo({ parentDir: outsideFakeTmp })).rejects.toThrow(GUARD_I_MESSAGE);

      let outsideFakeTmpExists = true;
      try {
        await stat(outsideFakeTmp);
      } catch {
        outsideFakeTmpExists = false;
      }
      expect(outsideFakeTmpExists).toBe(false);
    } finally {
      await rm(fakeTmpRoot, { recursive: true, force: true });
      await rm(outsideFakeTmp, { recursive: true, force: true });
    }
  });

  it('guard (i): parentDir outside os.tmpdir() but under an explicit allowRoot is permitted', async () => {
    const fakeTmpRoot = await mkdtemp(path.join(os.tmpdir(), 'scratch-git-test-faketmp-'));
    const allowRoot = await mkdtemp(path.join(path.dirname(fakeTmpRoot), 'scratch-git-test-allowroot-'));
    process.env.TMPDIR = fakeTmpRoot;

    try {
      const repo = await createScratchGitRepo({ parentDir: allowRoot, allowRoot });
      expect(repo.dir.startsWith(allowRoot)).toBe(true);
      await repo.cleanup();
    } finally {
      await rm(fakeTmpRoot, { recursive: true, force: true });
      await rm(allowRoot, { recursive: true, force: true });
    }
  });

  it('guard (ii): parentDir inside the real repository toplevel throws and leaves the real repo unchanged, even under an explicit allowRoot naming it', async () => {
    const toplevelResult = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(toplevelResult.exitCode).toBe(0);
    const toplevel = new TextDecoder().decode(toplevelResult.stdout).trim();

    const statusBefore = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: toplevel, stdout: 'pipe', stderr: 'pipe' });
    expect(statusBefore.exitCode).toBe(0);

    const insideRealRepo = path.join(toplevel, 'zzz-scratch-git-test-guard-ii-should-not-exist');

    try {
      // allowRoot explicitly names the real repo's toplevel, which
      // SATISFIES guard (i) -- so a throw here can only come from guard
      // (ii), and the assertion below is on guard (ii)'s specific message,
      // not the shared invariant-naming prefix, to prove exactly that. Per
      // the Architect's ruling (2026-09-24): guard (ii) is unconditional
      // and an allowRoot naming/containing the real toplevel must not
      // bypass it.
      await expect(createScratchGitRepo({ parentDir: insideRealRepo, allowRoot: toplevel })).rejects.toThrow(
        GUARD_II_MESSAGE,
      );

      let insideRealRepoExists = true;
      try {
        await stat(insideRealRepo);
      } catch {
        insideRealRepoExists = false;
      }
      expect(insideRealRepoExists).toBe(false);

      const statusAfter = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: toplevel, stdout: 'pipe', stderr: 'pipe' });
      expect(statusAfter.exitCode).toBe(0);
      expect(new TextDecoder().decode(statusAfter.stdout)).toBe(new TextDecoder().decode(statusBefore.stdout));
    } finally {
      // If a future mutation makes guard (ii) fail to throw, this directory
      // WOULD get created inside the real repository's toplevel -- clean it
      // up unconditionally so a mutation run never leaves the real worktree
      // dirty for the next test or the next `git status`.
      await rm(insideRealRepo, { recursive: true, force: true });
    }
  });

  it('guard (ii): a linked worktree case -- process.cwd() inside this worktree resolves this worktree as the toplevel to protect', async () => {
    const toplevelResult = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(toplevelResult.exitCode).toBe(0);
    const toplevel = new TextDecoder().decode(toplevelResult.stdout).trim();

    // This test suite itself runs inside a linked worktree (agent-console
    // uses one worktree per delegate). The AC's own risk note calls out
    // this exact case: `--show-toplevel` must resolve to the worktree, not
    // the main checkout, so that a scratch repo nested under the worktree
    // is still caught by guard (ii).
    expect(toplevel).not.toBe('');

    const insideThisWorktree = path.join(toplevel, 'zzz-scratch-git-test-worktree-guard-should-not-exist');
    try {
      await expect(createScratchGitRepo({ parentDir: insideThisWorktree, allowRoot: toplevel })).rejects.toThrow(
        GUARD_II_MESSAGE,
      );
    } finally {
      // See the sibling guard-(ii) test above: cleans up unconditionally in
      // case a future mutation makes the guard fail to throw.
      await rm(insideThisWorktree, { recursive: true, force: true });
    }
  });

  it('guard (ii) does not misfire on the ordinary path: parentDir under os.tmpdir(), no allowRoot, does not throw even though this suite itself runs inside the real repository', async () => {
    // Mirror of the guard-(ii) throw case (per the Architect's ruling,
    // 2026-09-24): every other test in this file already exercises this
    // path successfully via `scratchParent`, but this test states the
    // property explicitly -- process.cwd() resolves to this worktree's
    // real toplevel, and `scratchParent` (under os.tmpdir()) must not be
    // mistaken for a path inside it.
    const repo = await createScratchGitRepo({ parentDir: scratchParent });
    expect(repo.dir.startsWith(scratchParent)).toBe(true);
    await repo.cleanup();
  });

  it('boundary: initialCommit false leaves zero commits', async () => {
    const repo = await createScratchGitRepo({ parentDir: scratchParent, initialCommit: false });
    await expect(repo.git(['rev-parse', 'HEAD'])).rejects.toThrow();
    await repo.cleanup();
  });

  it('sanitizes an inherited GIT_CONFIG_COUNT/KEY/VALUE injection: the helper commit still succeeds despite an ambient commit.gpgsign=true triple', async () => {
    // Injects the EXACT same broken signer as the fake host HOME's
    // .gitconfig (commit.gpgsign / gpg.format / gpg.ssh.program), but via
    // the env-based GIT_CONFIG_COUNT/KEY/VALUE mechanism instead of a file
    // -- GIT_CONFIG_GLOBAL does NOT override this mechanism (a separate,
    // higher-precedence config source per git's own docs). If this
    // triple reached the actual `git commit`, the helper's own init+commit
    // would fail with the identical "cannot exec" error the POLARITY
    // test's withoutHelperEnv spawn produces. A clean construction (no
    // throw) is the assertion; a generic "no secret key" GPG failure would
    // ALSO indicate a leak (a narrower injection), so this uses the exact
    // signer to make any leak diagnostic rather than ambiguous.
    process.env.GIT_CONFIG_COUNT = '4';
    process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    process.env.GIT_CONFIG_KEY_1 = 'gpg.format';
    process.env.GIT_CONFIG_VALUE_1 = 'ssh';
    process.env.GIT_CONFIG_KEY_2 = 'gpg.ssh.program';
    process.env.GIT_CONFIG_VALUE_2 = '/nonexistent/op-ssh-sign';
    process.env.GIT_CONFIG_KEY_3 = 'user.signingkey';
    process.env.GIT_CONFIG_VALUE_3 = '/fake/path/to/ssh-signing-key.pub';
    try {
      const repo = await createScratchGitRepo({ parentDir: scratchParent });
      await repo.git(['commit', '--allow-empty', '-q', '-m', 'second commit despite injected triple']);
      await repo.cleanup();
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
      delete process.env.GIT_CONFIG_KEY_1;
      delete process.env.GIT_CONFIG_VALUE_1;
      delete process.env.GIT_CONFIG_KEY_2;
      delete process.env.GIT_CONFIG_VALUE_2;
      delete process.env.GIT_CONFIG_KEY_3;
      delete process.env.GIT_CONFIG_VALUE_3;
    }
  });

  it('sanitizes an inherited GIT_DIR: the helper commits into its own dir, never into a second scratch repo pointed to by ambient GIT_DIR', async () => {
    const otherRepo = await createScratchGitRepo({ parentDir: scratchParent });
    const otherHeadCountBefore = await otherRepo.git(['rev-list', '--count', 'HEAD']);

    process.env.GIT_DIR = path.join(otherRepo.dir, '.git');
    try {
      const repo = await createScratchGitRepo({ parentDir: scratchParent });

      // `--git-dir` (not `--show-toplevel`, which falls back to reporting
      // `cwd` itself whenever GIT_WORK_TREE is unset -- measured during
      // implementation to NOT discriminate this mutation, since the spawn's
      // cwd is already `repo.dir` regardless of GIT_DIR) reveals the
      // ACTUAL .git directory git resolved for this invocation, which is
      // GIT_DIR verbatim when set and unsanitized.
      const gitDir = await repo.git(['rev-parse', '--git-dir']);
      expect(path.resolve(repo.dir, gitDir)).toBe(path.join(repo.dir, '.git'));

      // otherRepo's history is untouched by anything that happened while
      // constructing `repo`.
      const otherHeadCountAfter = await otherRepo.git(['rev-list', '--count', 'HEAD']);
      expect(otherHeadCountAfter).toBe(otherHeadCountBefore);

      await repo.cleanup();
    } finally {
      delete process.env.GIT_DIR;
      await otherRepo.cleanup();
    }
  });

  it('guard (ii): a symlinked parentDir pointing INTO the real repository toplevel throws (both sides of every comparison are realpath-resolved)', async () => {
    const toplevelResult = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(toplevelResult.exitCode).toBe(0);
    const toplevel = new TextDecoder().decode(toplevelResult.stdout).trim();

    const targetInsideRepo = path.join(toplevel, 'zzz-scratch-git-test-symlink-target');
    const symlinkParent = path.join(os.tmpdir(), `scratch-git-test-symlink-${crypto.randomUUID().slice(0, 8)}`);

    await mkdir(targetInsideRepo, { recursive: true });
    await symlink(targetInsideRepo, symlinkParent);

    try {
      // symlinkParent's own literal path lives under os.tmpdir() -- a plain
      // path.resolve() (no realpath) would satisfy guard (i) trivially and
      // never trigger guard (ii), since the literal path never looks like
      // it is inside `toplevel`. allowRoot names the toplevel explicitly so
      // guard (i) is satisfied via the REAL (resolved) location too,
      // isolating guard (ii) specifically, same convention as the
      // non-symlinked guard-(ii) test above.
      await expect(createScratchGitRepo({ parentDir: symlinkParent, allowRoot: toplevel })).rejects.toThrow(
        GUARD_II_MESSAGE,
      );
    } finally {
      // Remove the symlink itself (not its target) first, then the target
      // directory and anything a broken guard created inside it.
      await rm(symlinkParent, { force: true });
      await rm(targetInsideRepo, { recursive: true, force: true });
    }
  });

  it('the fake host ~/.gitconfig is byte-identical before and after every test above', async () => {
    const currentStat = await stat(fakeHostConfigPath);
    const currentContent = await readFile(fakeHostConfigPath, 'utf-8');
    expect(currentStat.mtimeMs).toBe(fakeHostConfigSnapshot.mtimeMs);
    expect(currentContent).toBe(fakeHostConfigSnapshot.content);
  });
});
