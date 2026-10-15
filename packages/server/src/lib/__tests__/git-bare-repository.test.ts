/**
 * Real-git tests for `resolveGitDir` and `assertOriginFetchRefspec`
 * (`lib/git.ts`) on non-bare and BARE repositories.
 *
 * Hermetic git: the fixtures use `createScratchGitRepo` (scratch-git.ts), whose
 * throwaway global config keeps the operator's signing / hooks / aliases out of
 * these commits; every subprocess here runs with that repo's `env`.
 *
 * Why the functions under test run in a child process: `lib/git.js` is replaced
 * process-globally by `mock-git-helper.ts` in many sibling test files, so a test
 * that imported the real `lib/git.js` would bind to whichever mock state the
 * process happened to be in. A fresh `bun` child imports the REAL module. The
 * fixtures need directories a real `git` subprocess can see, so this file runs
 * in the second (real-fs) `bun test` invocation (`package.json`) and calls
 * `assertRealFs` first, per `testing.md`'s real-fs placement rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { createScratchGitRepo, type ScratchGitRepo } from '../../__tests__/utils/scratch-git.js';
import { buildCloneCommand } from '../../services/repository-clone-service.js';

const GIT_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts');
const WORKTREE_SERVICE_TS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'worktree-service.ts');

let scratch: ScratchGitRepo;

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: scratch.env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

/** `git <args>` with the scratch config, `cwd` as given (the scratch repo's own `git()` is fixed to its dir). */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(['git', ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r.out;
}

/** Run `body` (an async JS snippet using `dir`) in a fresh bun child importing the real lib/git.ts; returns its JSON result. */
async function inChild<T>(dir: string, body: string): Promise<T> {
  const script = `
    import * as lib from ${JSON.stringify(GIT_TS)};
    const dir = process.argv[1];
    const result = await (async () => { ${body} })();
    console.log(JSON.stringify(result));
  `;
  const r = await run(['bun', '-e', script, dir], dir);
  if (r.code !== 0) throw new Error(`child failed (${r.code}): ${r.err}`);
  return JSON.parse(r.out.split('\n').pop()!) as T;
}

describe('resolveGitDir / assertOriginFetchRefspec on real repositories', () => {
  let root: string;
  let upstream: string; // non-bare repo with a remote-ish role (has branches main + feature)
  let nonBare: string; // non-bare clone of upstream (has origin + refspec)
  let bare: string; // bare clone of upstream (origin url, NO refspec)
  let nonBareWt: string;
  let bareWt: string;

  beforeAll(async () => {
    await assertRealFs('git-bare-repository.test.ts setup');
    root = await mkdtemp(join(tmpdir(), 'git-bare-repository-'));
    scratch = await createScratchGitRepo({ parentDir: root, name: 'upstream-' });
    upstream = scratch.dir;
    await scratch.git(['branch', 'feature']);

    nonBare = join(root, 'nonbare');
    await git(['clone', '-q', upstream, nonBare], root);
    bare = join(root, 'bare.git');
    await git(['clone', '-q', '--bare', upstream, bare], root);
    nonBareWt = join(root, 'nonbare-wt');
    await git(['worktree', 'add', '-q', '--detach', nonBareWt, 'HEAD'], nonBare);
    bareWt = join(root, 'bare-wt');
    await git(['worktree', 'add', '-q', '--detach', bareWt, 'HEAD'], bare);
  });

  afterAll(async () => {
    if (scratch) await scratch.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe('resolveGitDir', () => {
    const resolveIn = (dir: string) =>
      inChild<{ gitDir: string; bare: boolean } | null>(dir, 'return await lib.resolveGitDir(dir);');

    it('a non-bare repository: its .git, bare=false', async () => {
      expect(await resolveIn(nonBare)).toEqual({ gitDir: join(nonBare, '.git'), bare: false });
    });

    it('a bare repository: the repository root itself, bare=true', async () => {
      expect(await resolveIn(bare)).toEqual({ gitDir: bare, bare: true });
    });

    it('a linked worktree of a non-bare repository resolves to that repository\'s .git', async () => {
      expect(await resolveIn(nonBareWt)).toEqual({ gitDir: join(nonBare, '.git'), bare: false });
    });

    it('a linked worktree of a BARE repository resolves to the bare dir with bare=true (the cwd form of --is-bare-repository would say false)', async () => {
      // The detection-site pin: inside the worktree the cwd form is false, which is
      // why bareness is asked of the common dir.
      expect((await run(['git', 'rev-parse', '--is-bare-repository'], bareWt)).out).toBe('false');
      expect(await resolveIn(bareWt)).toEqual({ gitDir: bare, bare: true });
    });

    it('a directory that is not a git repository: null', async () => {
      const plain = await mkdtemp(join(root, 'plain-'));
      expect(await resolveIn(plain)).toBeNull();
    });
  });

  describe('isBareRepositoryRoot', () => {
    const rootIn = (dir: string) => inChild<boolean>(dir, 'return await lib.isBareRepositoryRoot(dir);');

    it('the root of a bare repository: true', async () => {
      expect(await rootIn(bare)).toBe(true);
    });

    it('a linked worktree of a bare repository: false (resolveGitDir says bare=true there; only the root equality tells them apart)', async () => {
      expect(await inChild<{ gitDir: string; bare: boolean } | null>(bareWt, 'return await lib.resolveGitDir(dir);')).toEqual({
        gitDir: bare,
        bare: true,
      });
      expect(await rootIn(bareWt)).toBe(false);
    });

    it('the root of a non-bare repository: false', async () => {
      expect(await rootIn(nonBare)).toBe(false);
    });

    it('a directory that is not a git repository: false', async () => {
      expect(await rootIn(await mkdtemp(join(root, 'plain-root-')))).toBe(false);
    });
  });

  describe('assertOriginFetchRefspec (read-only)', () => {
    const assertIn = (dir: string) => inChild<string>(dir, 'return await lib.assertOriginFetchRefspec(dir);');

    it('a bare clone without the refspec is reported missing, and nothing was written', async () => {
      const own = join(root, 'bare-own.git');
      await git(['clone', '-q', '--bare', upstream, own], root);
      expect((await run(['git', 'config', '--get', 'remote.origin.fetch'], own)).code).not.toBe(0);

      expect(await assertIn(own)).toBe('missing');

      // Read-only: the check left the repository exactly as it found it.
      expect((await run(['git', 'config', '--get', 'remote.origin.fetch'], own)).code).not.toBe(0);
      expect((await run(['git', 'branch', '-r'], own)).out).toBe('');
    });

    it('polarity, both ways: without the refspec the helpers are broken; after the owner runs the two commands they work and the check says present', async () => {
      const own = join(root, 'bare-own-2.git');
      await git(['clone', '-q', '--bare', upstream, own], root);

      const result = await inChild<{ missing: string; before: string; beforeRemote: string[] }>(
        own,
        `
        const missing = await lib.assertOriginFetchRefspec(dir);
        const before = await lib.refreshDefaultBranch(dir).then(() => 'ok', () => 'threw');
        const beforeRemote = await lib.listRemoteBranches(dir);
        return { missing, before, beforeRemote };
        `,
      );
      expect(result).toEqual({ missing: 'missing', before: 'threw', beforeRemote: [] });

      // The two commands the registration refusal quotes, run as the owner.
      await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], own);
      await git(['fetch', 'origin'], own);

      const after = await inChild<{ present: string; refreshed: string; remote: string[] }>(
        own,
        `
        const present = await lib.assertOriginFetchRefspec(dir);
        const refreshed = await lib.refreshDefaultBranch(dir).then((b) => b, () => 'threw');
        const remote = await lib.listRemoteBranches(dir);
        return { present, refreshed, remote };
        `,
      );
      expect(after.present).toBe('present');
      expect(after.refreshed).toBe('main');
      expect(after.remote).toContain('origin/main');
      expect(after.remote).toContain('origin/feature');
    });

    it('a non-bare clone carries the refspec: present', async () => {
      expect(await inChild<string>(nonBare, 'return await lib.assertOriginFetchRefspec(dir);')).toBe('present');
    });

    it('a repository with no origin remote: nothing to track', async () => {
      expect(await inChild<string>(upstream, 'return await lib.assertOriginFetchRefspec(dir);')).toBe('no-remote');
    });
  });
});

describe('resolveGitDir on repositories owned by another OS user (git ownership check)', () => {
  // `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` is git's own knob that makes every
  // repository look foreign-owned, so the ownership check runs for real without
  // a second OS account. The global config lists `safe.directory` entries ONLY
  // (the registered repository path, as the production allow-list does), with no
  // other operator or scratch settings.
  let root: string;
  let own: ScratchGitRepo;
  let nonBare: string;
  let unlistedNonBare: string;
  let bare: string;
  let unlistedBare: string;
  let bareWt: string;

  const sh = async (args: string[], cwd: string): Promise<string> => {
    const proc = Bun.spawn(['git', ...args], { cwd, env: own.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed: ${err.trim()}`);
    return out.trim();
  };

  /** Writes a global config that lists exactly `listed` as safe.directory, and returns its path. */
  async function safeDirectoryConfig(name: string, listed: string[]): Promise<string> {
    const file = join(root, name);
    await writeFile(file, ['[safe]', ...listed.map((p) => `\tdirectory = ${p}`), ''].join('\n'), 'utf-8');
    return file;
  }

  /** `resolveGitDir(dir)` in a fresh bun child whose git sees every repository as foreign-owned and trusts only `listed`. */
  async function resolveAsForeign(dir: string, listed: string[]): Promise<{ gitDir: string; bare: boolean } | null> {
    const config = await safeDirectoryConfig(`safe-${Math.random().toString(36).slice(2)}.gitconfig`, listed);
    const script = `
      import * as lib from ${JSON.stringify(GIT_TS)};
      console.log(JSON.stringify(await lib.resolveGitDir(process.argv[1])));
    `;
    const proc = Bun.spawn(['bun', '-e', script, dir], {
      cwd: dir,
      env: { ...own.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: config },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`child failed: ${err.trim()}`);
    return JSON.parse(out.trim().split('\n').pop()!) as { gitDir: string; bare: boolean } | null;
  }

  beforeAll(async () => {
    await assertRealFs('git-bare-repository.test.ts foreign-owner setup');
    root = await mkdtemp(join(tmpdir(), 'git-foreign-owner-'));
    own = await createScratchGitRepo({ parentDir: root, name: 'upstream-' });

    nonBare = join(root, 'nonbare');
    unlistedNonBare = join(root, 'nonbare-unlisted');
    bare = join(root, 'bare.git');
    unlistedBare = join(root, 'bare-unlisted.git');
    bareWt = join(root, 'bare-wt');
    await sh(['clone', '-q', own.dir, nonBare], root);
    await sh(['clone', '-q', own.dir, unlistedNonBare], root);
    await sh(['clone', '-q', '--bare', own.dir, bare], root);
    await sh(['clone', '-q', '--bare', own.dir, unlistedBare], root);
    await sh(['worktree', 'add', '-q', '--detach', bareWt, 'HEAD'], bare);
  });

  afterAll(async () => {
    if (own) await own.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a non-bare repository listed as safe.directory resolves to its .git, bare=false (the probe must not discover from inside the git dir)', async () => {
    expect(await resolveAsForeign(nonBare, [nonBare])).toEqual({ gitDir: join(nonBare, '.git'), bare: false });
  });

  it('a bare repository root listed as safe.directory resolves to itself, bare=true (holds with and without the explicit git-dir probe)', async () => {
    expect(await resolveAsForeign(bare, [bare])).toEqual({ gitDir: bare, bare: true });
  });

  it('a linked worktree of a bare repository (worktree and bare root listed) resolves to the bare dir, bare=true', async () => {
    expect(await resolveAsForeign(bareWt, [bareWt, bare])).toEqual({ gitDir: bare, bare: true });
  });

  it('negative control: repositories that are NOT listed resolve to null, so the ownership check is active in the child', async () => {
    expect(await resolveAsForeign(unlistedNonBare, [nonBare])).toBeNull();
    expect(await resolveAsForeign(unlistedBare, [bare])).toBeNull();
  });
});

describe('source reads through the object store (readRepoFileAtRef / exportRepoTreeAtRef / resolveSourceReadRef / getRemoteUrl)', () => {
  let root: string;
  let own: ScratchGitRepo; // this describe's own hermetic upstream (the describe above cleans up its scratch config)
  let upstream: string;
  let nonBare: string;
  let bare: string; // bare clone WITHOUT the fetch refspec (as `git clone --bare` leaves it)

  const sh = async (args: string[], cwd: string): Promise<string> => {
    const proc = Bun.spawn(['git', ...args], { cwd, env: own.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed: ${err.trim()}`);
    return out.trim();
  };

  /** Run `body` (async JS using `dir`, `extra`) in a fresh bun child importing the real lib/git.ts. */
  async function child<T>(dir: string, body: string, extra: string[] = []): Promise<T> {
    const script = `
      import * as lib from ${JSON.stringify(GIT_TS)};
      const dir = process.argv[1];
      const extra = process.argv.slice(2);
      const result = await (async () => { ${body} })();
      console.log(JSON.stringify(result));
    `;
    const proc = Bun.spawn(['bun', '-e', script, dir, ...extra], { cwd: dir, env: own.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`child failed: ${err.trim()}`);
    return JSON.parse(out.trim().split('\n').pop()!) as T;
  }

  beforeAll(async () => {
    await assertRealFs('git-bare-repository.test.ts source-read setup');
    root = await mkdtemp(join(tmpdir(), 'git-source-read-'));
    own = await createScratchGitRepo({ parentDir: root, name: 'upstream-' });
    upstream = own.dir;

    await writeFile(join(upstream, 'README.md'), 'hello readme\n');
    await writeFile(join(upstream, 'empty.txt'), '');
    await mkdir(join(upstream, 'docs'), { recursive: true });
    await writeFile(join(upstream, 'docs', 'a.txt'), 'nested a\n');
    await mkdir(join(upstream, '.agent-console', 'sub'), { recursive: true });
    await writeFile(join(upstream, '.agent-console', 'top.md'), 'top {{BRANCH}}\n');
    await writeFile(join(upstream, '.agent-console', 'empty.md'), '');
    await writeFile(join(upstream, '.agent-console', 'sub', 'deep.md'), 'deep\n');
    await own.git(['add', '-A']);
    await own.git(['commit', '-q', '-m', 'content']);

    nonBare = join(root, 'nonbare');
    await sh(['clone', '-q', upstream, nonBare], root);
    bare = join(root, 'bare.git');
    await sh(['clone', '-q', '--bare', upstream, bare], root);
  });

  afterAll(async () => {
    if (own) await own.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe('readRepoFileAtRef', () => {
    const read = (dir: string, ref: string, rel: string) =>
      child<string | null>(dir, 'return await lib.readRepoFileAtRef(dir, extra[0], extra[1]);', [ref, rel]);

    it('bare: a present file at the top level is returned (git trims the trailing newline)', async () => {
      expect(await read(bare, 'HEAD', 'README.md')).toBe('hello readme');
    });

    it('bare: a nested path is returned', async () => {
      expect(await read(bare, 'HEAD', 'docs/a.txt')).toBe('nested a');
    });

    it('bare: an empty file is the empty string, not null', async () => {
      expect(await read(bare, 'HEAD', 'empty.txt')).toBe('');
    });

    it('bare: an absent path is null', async () => {
      expect(await read(bare, 'HEAD', 'NOPE.md')).toBeNull();
    });

    it('bare: an absent ref is null (nothing to read)', async () => {
      expect(await read(bare, 'origin/main', 'README.md')).toBeNull();
    });

    it('non-bare control: the same calls return the same values', async () => {
      expect(await read(nonBare, 'HEAD', 'README.md')).toBe('hello readme');
      expect(await read(nonBare, 'HEAD', 'docs/a.txt')).toBe('nested a');
      expect(await read(nonBare, 'HEAD', 'empty.txt')).toBe('');
      expect(await read(nonBare, 'HEAD', 'NOPE.md')).toBeNull();
    });
  });

  describe('exportRepoTreeAtRef', () => {
    const exportTo = (dir: string, ref: string, rel: string, dest: string) =>
      child<string | null>(dir, 'return await lib.exportRepoTreeAtRef(dir, extra[0], extra[1], extra[2]);', [ref, rel, dest]);

    async function snapshot(dir: string): Promise<Record<string, string>> {
      return {
        top: await readFile(join(dir, 'top.md'), 'utf-8'),
        empty: await readFile(join(dir, 'empty.md'), 'utf-8'),
        deep: await readFile(join(dir, 'sub', 'deep.md'), 'utf-8'),
      };
    }

    it('bare: exports the directory with its nested subdirectory and empty file, returning <dest>/<relPath>', async () => {
      const dest = await mkdtemp(join(root, 'export-bare-'));
      const out = await exportTo(bare, 'HEAD', '.agent-console', dest);
      expect(out).toBe(join(dest, '.agent-console'));
      expect(await snapshot(out!)).toEqual({ top: 'top {{BRANCH}}\n', empty: '', deep: 'deep\n' });
    });

    it('bare: a path absent at the ref returns null and leaves destDir empty', async () => {
      const dest = await mkdtemp(join(root, 'export-missing-'));
      expect(await exportTo(bare, 'HEAD', 'no-such-dir', dest)).toBeNull();
      expect((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: dest, dot: true }))).length).toBe(0);
    });

    it('bare: an unusable destDir is a GitError (tar failure), not null', async () => {
      const result = await child<{ name: string } | null>(
        bare,
        `try { await lib.exportRepoTreeAtRef(dir, 'HEAD', '.agent-console', extra[0]); return null; }
         catch (e) { return { name: e.name }; }`,
        [join(root, 'does-not-exist')],
      );
      expect(result).toEqual({ name: 'GitError' });
    });

    it('bare: an unresolvable ref is a GitError, not null (only a missing pathspec is "absent")', async () => {
      const dest = await mkdtemp(join(root, 'export-badref-'));
      const result = await child<{ name: string } | null>(
        bare,
        `try { return await lib.exportRepoTreeAtRef(dir, 'origin/main', '.agent-console', extra[0]); }
         catch (e) { return { name: e.name }; }`,
        [dest],
      );
      expect(result).toEqual({ name: 'GitError' });
    });

    it('bare: a symlink in the tree is extracted AS a symlink (not followed), so the template copy can detect and skip it', async () => {
      const linkRepo = await createScratchGitRepo({ parentDir: root, name: 'upstream-link-' });
      try {
        await mkdir(join(linkRepo.dir, '.agent-console'), { recursive: true });
        await writeFile(join(linkRepo.dir, '.agent-console', 'regular.md'), 'regular\n');
        await symlink('/etc/hostname', join(linkRepo.dir, '.agent-console', 'link.md'));
        await linkRepo.git(['add', '-A']);
        await linkRepo.git(['commit', '-q', '-m', 'with symlink']);
        const linkBare = join(root, 'bare-link.git');
        await sh(['clone', '-q', '--bare', linkRepo.dir, linkBare], root);

        const dest = await mkdtemp(join(root, 'export-symlink-'));
        const out = await exportTo(linkBare, 'HEAD', '.agent-console', dest);

        const linkStat = await lstat(join(out!, 'link.md'));
        expect(linkStat.isSymbolicLink()).toBe(true);
        expect(await readlink(join(out!, 'link.md'))).toBe('/etc/hostname');
        expect((await lstat(join(out!, 'regular.md'))).isSymbolicLink()).toBe(false);
      } finally {
        await linkRepo.cleanup();
      }
    });

    it('bare: an archive larger than maxBytes is a GitError naming the cap, and the default cap exports the same tree (control)', async () => {
      const capped = await child<{ name: string; message: string } | null>(
        bare,
        `try { await lib.exportRepoTreeAtRef(dir, 'HEAD', '.agent-console', extra[0], { maxBytes: 64 }); return null; }
         catch (e) { return { name: e.name, message: e.message }; }`,
        [await mkdtemp(join(root, 'export-capped-'))],
      );
      expect(capped).toEqual({ name: 'GitError', message: 'git archive output exceeds 64 bytes' });

      const dest = await mkdtemp(join(root, 'export-uncapped-'));
      const out = await exportTo(bare, 'HEAD', '.agent-console', dest);
      expect(await snapshot(out!)).toEqual({ top: 'top {{BRANCH}}\n', empty: '', deep: 'deep\n' });
    });

    it('non-bare control: the export is byte-identical to the bare one', async () => {
      const dest = await mkdtemp(join(root, 'export-nonbare-'));
      const out = await exportTo(nonBare, 'HEAD', '.agent-console', dest);
      expect(out).toBe(join(dest, '.agent-console'));
      expect(await snapshot(out!)).toEqual({ top: 'top {{BRANCH}}\n', empty: '', deep: 'deep\n' });
      expect(await exportTo(nonBare, 'HEAD', 'no-such-dir', await mkdtemp(join(root, 'export-nonbare-miss-')))).toBeNull();
    });
  });

  describe('resolveSourceReadRef and the stale-local-branch trap', () => {
    it('refspec missing: HEAD', async () => {
      expect(await child<string>(bare, 'return await lib.resolveSourceReadRef(dir);')).toBe('HEAD');
    });

    it('no remote at all: HEAD', async () => {
      expect(await child<string>(upstream, 'return await lib.resolveSourceReadRef(dir);')).toBe('HEAD');
    });

    it('after the refspec is set and fetched, reads follow origin/<default>; the local branch stays at clone time', async () => {
      const fresh = join(root, 'bare-fresh.git');
      await sh(['clone', '-q', '--bare', upstream, fresh], root);
      await sh(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], fresh);
      await sh(['fetch', '-q', 'origin'], fresh);

      // A commit lands upstream AFTER the clone.
      await writeFile(join(upstream, 'LATER.md'), 'later\n');
      await own.git(['add', '-A']);
      await own.git(['commit', '-q', '-m', 'later']);
      await sh(['fetch', '-q', 'origin'], fresh);

      const result = await child<{ ref: string; viaRef: string | null; viaMain: string | null }>(
        fresh,
        `const ref = await lib.resolveSourceReadRef(dir);
         return {
           ref,
           viaRef: await lib.readRepoFileAtRef(dir, ref, 'LATER.md'),
           viaMain: await lib.readRepoFileAtRef(dir, 'main', 'LATER.md'),
         };`,
      );
      expect(result).toEqual({ ref: 'origin/main', viaRef: 'later', viaMain: null });
    });

    it('non-bare control: refspec is present, so the same resolver yields origin/<default>', async () => {
      expect(await child<string>(nonBare, 'return await lib.resolveSourceReadRef(dir);')).toBe('origin/main');
    });
  });

  describe('getRemoteUrl on a bare repository', () => {
    it('bare: returns the upstream URL (feeds resolveDefaultOrgRepo)', async () => {
      expect(await child<string | null>(bare, 'return await lib.getRemoteUrl(dir);')).toBe(upstream);
    });

    it('non-bare control: same', async () => {
      expect(await child<string | null>(nonBare, 'return await lib.getRemoteUrl(dir);')).toBe(upstream);
    });
  });
});

describe('readTemplateFileNoFollow (worktree-service) on a real filesystem', () => {
  let root: string;

  /** Run `body` (async JS using `file`) in a fresh bun child importing the REAL worktree-service. */
  async function readIn(file: string): Promise<unknown> {
    const script = `
      import { readTemplateFileNoFollow } from ${JSON.stringify(WORKTREE_SERVICE_TS)};
      console.log(JSON.stringify(await readTemplateFileNoFollow(process.argv[1])));
    `;
    const proc = Bun.spawn(['bun', '-e', script, file], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`child failed: ${err.trim()}`);
    return JSON.parse(out.trim().split('\n').pop()!);
  }

  beforeAll(async () => {
    await assertRealFs('git-bare-repository.test.ts template-read setup');
    root = await mkdtemp(join(tmpdir(), 'template-read-'));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a regular file: its content', async () => {
    const file = join(root, 'regular.md');
    await writeFile(file, 'hello {{BRANCH}}\n');
    expect(await readIn(file)).toEqual({ kind: 'content', content: 'hello {{BRANCH}}\n' });
  });

  it('a symlink to a readable file: skipped as a symlink, and the target content is NOT returned', async () => {
    const target = join(root, 'secret.txt');
    await writeFile(target, 'server-only secret\n');
    const link = join(root, 'link.md');
    await symlink(target, link);
    const result = await readIn(link);
    expect(result).toEqual({ kind: 'skipped', reason: 'symlink' });
    expect(JSON.stringify(result)).not.toContain('server-only secret');
  });

  it('a directory: skipped as non-regular', async () => {
    const dir = join(root, 'a-directory');
    await mkdir(dir);
    expect(await readIn(dir)).toEqual({ kind: 'skipped', reason: 'non-regular' });
  });

  it('a FIFO: skipped as non-regular, without blocking on the missing writer', async () => {
    const fifo = join(root, 'a-fifo');
    expect(await Bun.spawn(['mkfifo', fifo]).exited).toBe(0);
    expect(await readIn(fifo)).toEqual({ kind: 'skipped', reason: 'non-regular' });
  });
});

describe('buildCloneCommand (repository-clone-service) run for real against a scratch upstream', () => {
  // Proxy, recorded: the service's URL validation rejects file:// URLs, so the
  // composition is exercised through the exported builder with `sh -c` (what
  // runAsUser executes), not through enqueueClone. Everything downstream of the
  // command string is production-real: real git, real clone, real helpers.
  let root: string;
  let own: ScratchGitRepo;

  const shell = async (command: string, cwd: string): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn(['sh', '-c', command], { cwd, env: own.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: out.trim(), err: err.trim() };
  };

  async function inLib<T>(dir: string, body: string): Promise<T> {
    const script = `
      import * as lib from ${JSON.stringify(GIT_TS)};
      const dir = process.argv[1];
      const result = await (async () => { ${body} })();
      console.log(JSON.stringify(result));
    `;
    const proc = Bun.spawn(['bun', '-e', script, dir], { cwd: dir, env: own.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(`child failed: ${err.trim()}`);
    return JSON.parse(out.trim().split('\n').pop()!) as T;
  }

  beforeAll(async () => {
    await assertRealFs('git-bare-repository.test.ts buildCloneCommand setup');
    root = await mkdtemp(join(tmpdir(), 'git-bare-clone-command-'));
    own = await createScratchGitRepo({ parentDir: root, name: 'upstream-' });
    await own.git(['branch', 'feature']);
  });

  afterAll(async () => {
    if (own) await own.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('bare: the command leaves a repository whose refspec check, default-branch refresh and remote listing all work', async () => {
    const target = join(root, 'bare-target');
    const result = await shell(buildCloneCommand({ url: own.dir, targetDir: target, bare: true }), root);
    expect(result.code).toBe(0);

    const state = await inLib<{ refspec: string; refreshed: string; remote: string[] }>(
      target,
      `
      const refspec = await lib.assertOriginFetchRefspec(dir);
      const refreshed = await lib.refreshDefaultBranch(dir).then((b) => b, () => 'threw');
      const remote = await lib.listRemoteBranches(dir);
      return { refspec, refreshed, remote };
      `,
    );
    expect(state.refspec).toBe('present');
    expect(state.refreshed).toBe('main');
    expect(state.remote).toContain('origin/main');
    expect(state.remote).toContain('origin/feature');
  });

  it('polarity, both layers: a plain bare clone has no refspec and refreshDefaultBranch fails; the command cut before set-head has the refspec but no origin/HEAD; the full command has origin/HEAD and the tracking refs', async () => {
    type Observed = { refspec: string; remoteBefore: string[]; refreshed: string };
    const observe = (dir: string) =>
      inLib<Observed>(
        dir,
        `
        const refspec = await lib.assertOriginFetchRefspec(dir);
        const remoteBefore = await lib.listRemoteBranches(dir);
        const refreshed = await lib.refreshDefaultBranch(dir).then((b) => b, () => 'threw');
        return { refspec, remoteBefore, refreshed };
        `,
      );
    const hasOriginHead = async (dir: string) => (await shell('git symbolic-ref -q refs/remotes/origin/HEAD', dir)).code === 0;

    // (a) what `git clone --bare` alone leaves: the failure the set-head step and the refspec exist to prevent.
    const plain = join(root, 'bare-plain');
    expect((await shell(`git clone --bare '${own.dir}' '${plain}'`, root)).code).toBe(0);
    const plainState = await observe(plain);
    expect(plainState.refspec).toBe('missing');
    expect(plainState.remoteBefore).toEqual([]);
    expect(plainState.refreshed).toBe('threw');

    // (b) the builder's command cut before the set-head step: refspec present, but no origin/HEAD.
    const full = buildCloneCommand({ url: own.dir, targetDir: join(root, 'bare-cut'), bare: true });
    const cut = join(root, 'bare-cut');
    expect((await shell(full.slice(0, full.indexOf(' && ')), root)).code).toBe(0);
    expect(await hasOriginHead(cut)).toBe(false);
    // Measured with this git: the refspec given at clone time already makes the
    // clone itself write the tracking refs, so no separate fetch is needed;
    // what only the set-head step adds is origin/HEAD.
    expect((await shell('git branch -r', cut)).out).toContain('origin/main');

    // (c) the full command: tracking refs and origin/HEAD exist immediately.
    const target = join(root, 'bare-full');
    expect((await shell(buildCloneCommand({ url: own.dir, targetDir: target, bare: true }), root)).code).toBe(0);
    expect(await hasOriginHead(target)).toBe(true);
    const trackingRefs = (await shell('git branch -r', target)).out;
    expect(trackingRefs).toContain('origin/main');
    expect(trackingRefs).toContain('origin/feature');
    const fullState = await observe(target);
    expect(fullState.refspec).toBe('present');
    expect(fullState.remoteBefore).toContain('origin/main');
    expect(fullState.remoteBefore).toContain('origin/feature');
    expect(fullState.refreshed).toBe('main');
  });

  it('control, non-bare: the default command makes an ordinary clone with a working tree and the refspec', async () => {
    const target = join(root, 'nonbare-target');
    const result = await shell(buildCloneCommand({ url: own.dir, targetDir: target }), root);
    expect(result.code).toBe(0);
    expect((await shell('git rev-parse --is-bare-repository', target)).out).toBe('false');
    expect(await inLib<string>(target, 'return await lib.assertOriginFetchRefspec(dir);')).toBe('present');
  });

  it('a failing step fails the whole command (non-zero), so the service cleans the directory up', async () => {
    const target = join(root, 'bare-bad-url');
    const result = await shell(buildCloneCommand({ url: join(root, 'does-not-exist'), targetDir: target, bare: true }), root);
    expect(result.code).not.toBe(0);
  });

  describe('empty upstream (no commits, so no remote-tracking refs after the clone)', () => {
    let empty: ScratchGitRepo;
    const hasOriginHead = async (dir: string) => (await shell('git symbolic-ref -q refs/remotes/origin/HEAD', dir)).code === 0;
    const defaultBranchOf = (dir: string) => inLib<string | null>(dir, 'return await lib.getDefaultBranch(dir);');

    beforeAll(async () => {
      empty = await createScratchGitRepo({ parentDir: root, name: 'empty-upstream-', initialCommit: false });
    });

    afterAll(async () => {
      if (empty) await empty.cleanup();
    });

    it('bare: the clone is kept and registers as the non-bare clone does, and becomes fully usable after the first commit and a fetch', async () => {
      const target = join(root, 'bare-empty');
      const result = await shell(buildCloneCommand({ url: empty.dir, targetDir: target, bare: true }), root);
      expect(result.code).toBe(0);
      expect((await shell('git rev-parse --is-bare-repository', target)).out).toBe('true');
      expect(await inLib<string>(target, 'return await lib.assertOriginFetchRefspec(dir);')).toBe('present');
      expect(await hasOriginHead(target)).toBe(false);
      expect(await defaultBranchOf(target)).toBeNull();

      // Control, same upstream: the non-bare command also succeeds and also has no default branch.
      const control = join(root, 'nonbare-empty');
      expect((await shell(buildCloneCommand({ url: empty.dir, targetDir: control }), root)).code).toBe(0);
      expect(await defaultBranchOf(control)).toBeNull();

      // Recovery: this is what justifies keeping the clone.
      await empty.git(['commit', '--allow-empty', '-q', '-m', 'first']);
      expect((await shell('git fetch -q origin', target)).code).toBe(0);
      expect(await inLib<string>(target, 'return await lib.refreshDefaultBranch(dir);')).toBe('main');
      expect(await hasOriginHead(target)).toBe(true);
    });
  });

  describe('gate polarity: the set-head step is skipped only when there are no tracking refs, a real failure still fails', () => {
    const trailingFragment = (targetDir: string): string => {
      const full = buildCloneCommand({ url: own.dir, targetDir, bare: true });
      return full.slice(full.indexOf(' && ') + 4);
    };

    it('(i) a populated bare clone whose origin url no longer resolves: the fragment exits non-zero', async () => {
      const target = join(root, 'bare-gate-populated');
      expect((await shell(buildCloneCommand({ url: own.dir, targetDir: target, bare: true }), root)).code).toBe(0);
      expect((await shell(`git remote set-url origin '${join(root, 'does-not-exist')}'`, target)).code).toBe(0);
      expect((await shell(trailingFragment(target), root)).code).not.toBe(0);
    });

    it('(iii) the ref inspection itself fails (the directory is not a repository): the fragment exits non-zero', async () => {
      const notARepo = join(root, 'gate-not-a-repo');
      expect((await shell(`mkdir -p '${notARepo}'`, root)).code).toBe(0);
      expect((await shell(trailingFragment(notARepo), root)).code).not.toBe(0);
    });

    it('(ii) an empty bare clone: the fragment exits zero', async () => {
      const emptyUpstream = await createScratchGitRepo({ parentDir: root, name: 'gate-empty-upstream-', initialCommit: false });
      try {
        const target = join(root, 'bare-gate-empty');
        const full = buildCloneCommand({ url: emptyUpstream.dir, targetDir: target, bare: true });
        expect((await shell(full.slice(0, full.indexOf(' && ')), root)).code).toBe(0);
        expect((await shell(full.slice(full.indexOf(' && ') + 4), root)).code).toBe(0);
      } finally {
        await emptyUpstream.cleanup();
      }
    });
  });
});
