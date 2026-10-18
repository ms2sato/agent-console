/**
 * Runs the command `readWorkingTreeFile` hands to the elevated shell against a
 * REAL shell and a REAL directory, so the exit-code contract (0 file, 42
 * directory, non-zero with `No such file` for a missing path) is observed, not
 * assumed from the command's text.
 *
 * Real-fs placement: the fixtures need a directory a real `sh` can see, so this
 * file runs in the second (real-fs) `bun test` invocation (`package.json`) and
 * calls `assertRealFs` first. The builder is obtained from a fresh `bun` child
 * because `lib/git.js` is replaced process-globally by `mock-git-helper.ts` in
 * many sibling test files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';

const GIT_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts');

let tmpDir: string;
let otherDir: string;
let fifoMade = false;

/**
 * Runs a command to completion, or kills it after `timeoutMs`. The kill turns a
 * `cat` that blocks on a fifo into a prompt, assertable failure (code 137)
 * instead of a hung test run.
 */
async function runShell(
  cmd: string[],
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } finally {
    clearTimeout(timer);
  }
}

/** The real `buildWorkingTreeReadCommand(cwd, relPath, opts)`, evaluated in a fresh bun child. */
async function buildCommand(cwd: string, relPath: string, opts: object = {}): Promise<string> {
  const script = `
    import { buildWorkingTreeReadCommand } from ${JSON.stringify(GIT_TS)};
    console.log(JSON.stringify(buildWorkingTreeReadCommand(process.argv[1], process.argv[2], JSON.parse(process.argv[3]))));
  `;
  const r = await runShell(['bun', '-e', script, cwd, relPath, JSON.stringify(opts)], tmpDir);
  if (r.code !== 0) throw new Error(`child failed (${r.code}): ${r.err}`);
  return JSON.parse(r.out.trim().split('\n').pop()!) as string;
}

/**
 * Runs the command from `otherDir`, NOT from the worktree: the elevated
 * wrapper's `cd` can fail and leave the shell somewhere else, so the command
 * must not depend on the shell's cwd.
 */
async function readInShell(relPath: string, worktree: string = tmpDir, opts: object = {}, timeoutMs?: number) {
  return runShell(['sh', '-c', await buildCommand(worktree, relPath, opts)], otherDir, timeoutMs);
}

describe('buildWorkingTreeReadCommand in a real shell', () => {
  beforeAll(async () => {
    await assertRealFs('git-working-tree-read-shell');
    tmpDir = await mkdtemp(join(tmpdir(), 'wt-read-shell-'));
    otherDir = await mkdtemp(join(tmpdir(), 'wt-read-other-'));
    await writeFile(join(tmpDir, 'plain.txt'), 'hello\nworld\n');
    await writeFile(join(tmpDir, 'marker.txt'), '__AC_DIR__\n');
    await mkdir(join(tmpDir, 'sub'));
    await symlink('plain.txt', join(tmpDir, 'link-to-plain'));
    await symlink('sub', join(tmpDir, 'link-to-sub'));
    await symlink('nowhere', join(tmpDir, 'dangling'));
    await writeFile(join(tmpDir, 'two-hundred.txt'), 'x'.repeat(200));
    await writeFile(join(tmpDir, 'empty.txt'), '');
    fifoMade = (await runShell(['mkfifo', join(tmpDir, 'pipe')], tmpDir)).code === 0;
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true });
    if (otherDir) await rm(otherDir, { recursive: true });
  });

  it('regular file: exits 0 and stdout is the file bytes including the trailing newline', async () => {
    const r = await readInShell('plain.txt');
    expect(r.code).toBe(0);
    expect(r.out).toBe('hello\nworld\n');
  });

  it('regular file whose content is exactly __AC_DIR__\\n: exits 0 and stdout is that content', async () => {
    const r = await readInShell('marker.txt');
    expect(r.code).toBe(0);
    expect(r.out).toBe('__AC_DIR__\n');
  });

  it('directory: exits 42 with empty stdout', async () => {
    const r = await readInShell('sub');
    expect(r.code).toBe(42);
    expect(r.out).toBe('');
  });

  it('missing path: exits non-zero and stderr says `No such file`', async () => {
    const r = await readInShell('does-not-exist.txt');
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(42);
    expect(r.err).toContain('No such file');
  });

  it('path under a missing worktree directory: exits non-zero (not 0 or 42) and stderr says `No such file`', async () => {
    const r = await readInShell('plain.txt', join(tmpDir, 'gone-worktree'));
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(42);
    expect(r.err).toContain('No such file');
  });

  it('does not pick up a same-named file in the shell cwd', async () => {
    await writeFile(join(otherDir, 'plain.txt'), 'WRONG\n');
    const r = await readInShell('plain.txt');
    expect(r.out).toBe('hello\nworld\n');
  });

  describe('regularOnly (the file viewer\'s probe)', () => {
    const opts = { regularOnly: true };

    it('regular file: exits 0 with the bytes, same as without the option', async () => {
      const r = await readInShell('plain.txt', tmpDir, opts);
      expect(r.code).toBe(0);
      expect(r.out).toBe('hello\nworld\n');
    });

    it('symlink to a regular file: exits 0 with the target\'s bytes', async () => {
      const r = await readInShell('link-to-plain', tmpDir, opts);
      expect(r.code).toBe(0);
      expect(r.out).toBe('hello\nworld\n');
    });

    it('directory (and a symlink to one): still exits 42, the directory probe runs first', async () => {
      expect((await readInShell('sub', tmpDir, opts)).code).toBe(42);
      expect((await readInShell('link-to-sub', tmpDir, opts)).code).toBe(42);
    });

    it('fifo: exits 43 promptly instead of blocking in cat', async () => {
      if (!fifoMade) return; // the filesystem refuses mkfifo
      const r = await readInShell('pipe', tmpDir, opts, 5_000);
      expect(r.code).toBe(43);
      expect(r.out).toBe('');
    });

    it('missing path and dangling symlink: not 43 (that is "exists but not regular"); the read fails with `No such file`', async () => {
      for (const rel of ['does-not-exist.txt', 'dangling']) {
        const r = await readInShell(rel, tmpDir, opts);
        expect(r.code).not.toBe(0);
        expect(r.code).not.toBe(42);
        expect(r.code).not.toBe(43);
        expect(r.err).toContain('No such file');
      }
    });

    it('without the option a symlink to a regular file reads the same (default unchanged)', async () => {
      const r = await readInShell('link-to-plain');
      expect(r.code).toBe(0);
      expect(r.out).toBe('hello\nworld\n');
    });
  });

  describe('maxBytes (size line, then a bounded head)', () => {
    const opts = { regularOnly: true, maxBytes: 100 };

    it('a file over the bound: the size line is the total, the content is the first maxBytes bytes', async () => {
      const r = await readInShell('two-hundred.txt', tmpDir, opts);
      expect(r.code).toBe(0);
      const newline = r.out.indexOf('\n');
      expect(Number.parseInt(r.out.slice(0, newline).trim(), 10)).toBe(200);
      expect(r.out.slice(newline + 1)).toBe('x'.repeat(100));
    });

    it('a file under the bound is returned whole, an empty file is the size line alone', async () => {
      const small = await readInShell('plain.txt', tmpDir, opts);
      expect(Number.parseInt(small.out.slice(0, small.out.indexOf('\n')).trim(), 10)).toBe(12);
      expect(small.out.slice(small.out.indexOf('\n') + 1)).toBe('hello\nworld\n');
      const empty = await readInShell('empty.txt', tmpDir, opts);
      expect(empty.code).toBe(0);
      expect(empty.out.trim()).toBe('0');
      expect(empty.out.slice(empty.out.indexOf('\n') + 1)).toBe('');
    });
  });
});
