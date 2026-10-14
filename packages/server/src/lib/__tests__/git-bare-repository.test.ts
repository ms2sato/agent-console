/**
 * Real-git tests for `resolveGitDir` and `ensureOriginFetchRefspec`
 * (`lib/git.ts`) on non-bare and BARE repositories.
 *
 * Why a child process and no `fs`: `lib/git.js` is replaced process-globally by
 * `mock-git-helper.ts` in many sibling test files, and `fs` by `mock-fs-helper.ts`
 * (memfs). A test that imported the real `lib/git.js` or made its fixtures with
 * `fs` would bind to whichever mock state the process happened to be in. So the
 * fixtures are built with `git` subprocesses and the functions under test run in
 * a fresh `bun` child that imports the REAL module -- immune to both mocks, and
 * it needs no `assertRealFs` registration. The same reason `git-bare-...` does
 * not import `mock-git-helper.ts`.
 *
 * Hermetic env: `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` so the
 * operator's signing / hooks / aliases never reach these commits, and no repo
 * location variable is inherited.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts');

const BASE_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) =>
      v !== undefined &&
      !k.startsWith('GIT_') &&
      !k.startsWith('AGENT_CONSOLE_'),
  ) as [string, string][],
);
const GIT_ENV = { ...BASE_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

async function run(cmd: string[], cwd: string, env: Record<string, string> = GIT_ENV): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], cwd);
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

describe('resolveGitDir / ensureOriginFetchRefspec on real repositories', () => {
  let root: string;
  let upstream: string; // non-bare repo with a remote-ish role (has branches main + feature)
  let nonBare: string; // non-bare clone of upstream (has origin + refspec)
  let bare: string; // bare clone of upstream (origin url, NO refspec)
  let nonBareWt: string;
  let bareWt: string;

  beforeAll(async () => {
    root = (await run(['mktemp', '-d', join(tmpdir(), 'git-bare-repository-XXXXXX')], '/')).out;
    upstream = join(root, 'upstream');
    await run(['mkdir', '-p', upstream], root);
    await git(['init', '-q', '-b', 'main'], upstream);
    await git(['commit', '-q', '--allow-empty', '-m', 'init'], upstream);
    await git(['branch', 'feature'], upstream);

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
    if (root) await run(['rm', '-r', root], '/');
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
      const plain = join(root, 'plain');
      await run(['mkdir', '-p', plain], root);
      expect(await resolveIn(plain)).toBeNull();
    });
  });

  describe('ensureOriginFetchRefspec', () => {
    it('on a bare clone (refspec absent): before, branch -r is empty and refreshDefaultBranch fails; after, tracking refs exist and it succeeds; a second call is a no-op', async () => {
      // Fresh bare clone so this case does not depend on test order.
      const own = join(root, 'bare-own.git');
      await git(['clone', '-q', '--bare', upstream, own], root);
      expect((await run(['git', 'config', '--get', 'remote.origin.fetch'], own)).code).not.toBe(0);

      const result = await inChild<{
        before: string;
        beforeRemote: string[];
        outcome: string;
        after: string;
        afterRemote: string[];
        again: string;
      }>(
        own,
        `
        const before = await lib.refreshDefaultBranch(dir).then(() => 'ok', () => 'threw');
        const beforeRemote = await lib.listRemoteBranches(dir);
        const outcome = await lib.ensureOriginFetchRefspec(dir);
        const after = await lib.refreshDefaultBranch(dir).then((b) => b, () => 'threw');
        const afterRemote = await lib.listRemoteBranches(dir);
        const again = await lib.ensureOriginFetchRefspec(dir);
        return { before, beforeRemote, outcome, after, afterRemote, again };
        `,
      );

      // Polarity (doc measurement 3.1 reproduced): without the refspec these are the broken shapes.
      expect(result.before).toBe('threw');
      expect(result.beforeRemote).toEqual([]);
      expect(result.outcome).toBe('configured');
      expect(result.after).toBe('main');
      expect(result.afterRemote).toContain('origin/main');
      expect(result.afterRemote).toContain('origin/feature');
      expect(result.again).toBe('present');
      expect((await run(['git', 'config', '--get', 'remote.origin.fetch'], own)).out).toBe('+refs/heads/*:refs/remotes/origin/*');
    });

    it('a non-bare clone already carries the refspec: a no-op', async () => {
      expect(await inChild<string>(nonBare, 'return await lib.ensureOriginFetchRefspec(dir);')).toBe('present');
    });

    it('a repository with no origin remote: nothing to configure', async () => {
      expect(await inChild<string>(upstream, 'return await lib.ensureOriginFetchRefspec(dir);')).toBe('no-remote');
    });
  });
});
