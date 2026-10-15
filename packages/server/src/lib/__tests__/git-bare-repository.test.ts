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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { createScratchGitRepo, type ScratchGitRepo } from '../../__tests__/utils/scratch-git.js';

const GIT_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts');

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
