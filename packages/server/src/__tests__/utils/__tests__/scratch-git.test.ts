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
 * power"): removing `GIT_CONFIG_GLOBAL` from the env `createScratchGitRepo`
 * returns makes the POLARITY test below fail (the helper-routed commit then
 * also fails on the fake host signer). Removing guard (ii)'s toplevel check
 * makes the "guard (ii)" test below fail (no throw, and a stray directory
 * would appear under the real repository's toplevel). Both were measured
 * against this file during implementation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('the fake host ~/.gitconfig is byte-identical before and after every test above', async () => {
    const currentStat = await stat(fakeHostConfigPath);
    const currentContent = await readFile(fakeHostConfigPath, 'utf-8');
    expect(currentStat.mtimeMs).toBe(fakeHostConfigSnapshot.mtimeMs);
    expect(currentContent).toBe(fakeHostConfigSnapshot.content);
  });
});
