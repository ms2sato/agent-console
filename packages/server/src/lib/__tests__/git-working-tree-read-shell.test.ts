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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';

const GIT_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts');

let tmpDir: string;
let otherDir: string;

async function runShell(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** The real `buildWorkingTreeReadCommand(cwd, relPath)`, evaluated in a fresh bun child. */
async function buildCommand(cwd: string, relPath: string): Promise<string> {
  const script = `
    import { buildWorkingTreeReadCommand } from ${JSON.stringify(GIT_TS)};
    console.log(JSON.stringify(buildWorkingTreeReadCommand(process.argv[1], process.argv[2])));
  `;
  const r = await runShell(['bun', '-e', script, cwd, relPath], tmpDir);
  if (r.code !== 0) throw new Error(`child failed (${r.code}): ${r.err}`);
  return JSON.parse(r.out.trim().split('\n').pop()!) as string;
}

/**
 * Runs the command from `otherDir`, NOT from the worktree: the elevated
 * wrapper's `cd` can fail and leave the shell somewhere else, so the command
 * must not depend on the shell's cwd.
 */
async function readInShell(relPath: string, worktree: string = tmpDir) {
  return runShell(['sh', '-c', await buildCommand(worktree, relPath)], otherDir);
}

describe('buildWorkingTreeReadCommand in a real shell', () => {
  beforeAll(async () => {
    await assertRealFs('git-working-tree-read-shell');
    tmpDir = await mkdtemp(join(tmpdir(), 'wt-read-shell-'));
    otherDir = await mkdtemp(join(tmpdir(), 'wt-read-other-'));
    await writeFile(join(tmpDir, 'plain.txt'), 'hello\nworld\n');
    await writeFile(join(tmpDir, 'marker.txt'), '__AC_DIR__\n');
    await mkdir(join(tmpDir, 'sub'));
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
});
