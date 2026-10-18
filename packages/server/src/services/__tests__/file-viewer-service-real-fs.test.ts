/**
 * The file viewer service against REAL files and a REAL shell: the design
 * document's boundary table, run in both modes the service has --
 *   - `direct`: no OS user (single-user mode, or the spawn user is the server
 *     user), in-process `fs`;
 *   - `shell`: an OS user is given, so every list / resolve / read goes
 *     through `runAsUser`. With `AUTH_MODE` unset, `runAsUser` bypasses
 *     elevation and runs the very same command with a local `sh -c`, which is
 *     what lets the shell branch run for real here without any elevation.
 * plus the command builders evaluated in a real `sh` from a working directory
 * that is NOT the target (the inner command must not depend on the wrapper's
 * `cd`).
 *
 * Real-fs placement: symlinks, fifos and a real `sh` need the real filesystem,
 * so this file runs in the second (real-fs) `bun test` invocation
 * (`package.json`) and calls `assertRealFs` first.
 *
 * Measured reach (each mutation applied to the production line, the tests run,
 * the line restored; failures named by test, over this file plus
 * file-viewer-service.test.ts and workers-files-real-fs.test.ts):
 *   - drop the real-path containment check: the three "symlink ... outside ... refused"
 *     tests in BOTH modes (6), the "path through a symlink that leaves the tree" test
 *     in both modes, plus 3 unit tests in file-viewer-service.test.ts (outside root,
 *     string-prefix sibling, read-never-happens) and the 2 route tests.
 *   - `! -type d ! -type l` -> `-type f` in the listing: "a fifo is listed as a file"
 *     (shell mode), "three sections in the documented order" (real sh), and the two
 *     command-string unit tests; the direct mode cannot see it (it never runs find).
 *   - drop `test -e` from the realpath command: "a missing directory and a dangling
 *     symlink are NotFound" (shell mode) and the realpath real-sh test.
 *   - drop `test -d` from the listing command: "a tree request for a file" (shell mode)
 *     and the "empty directory ... exits 44" real-sh test.
 *   - drop regularOnly from the builder: the shell-mode fifo test; from the in-process
 *     path: the direct-mode fifo test and the character-device test below.
 *   - binary window 8192 -> 8193 / 8191: the "NUL at byte 8193" / "NUL within the first
 *     8 KiB" test of each mode.
 *   - list the lexical path instead of the real path: "a symlink to a directory inside
 *     the working directory, expanded" (shell mode).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn, type Mock } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { constants as fsConstants, closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { InternalError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { serverConfig } from '../../lib/server-config.js';
import { readWorkingTreeFile } from '../../lib/git.js';
import {
  buildDirectoryListingCommand,
  buildRealpathCommand,
  listDirectory,
  parseDirectoryListing,
  readFileContent,
} from '../file-viewer-service.js';

// The real `stat`, captured ONCE at import, before any spy exists. Reading `fsPromises.stat` again
// after a spy is installed returns the spy itself (spyOn on an already-spied property reuses the mock),
// and a spy that delegates to it would recurse until the stack overflows.
const REAL_STAT = fsPromises.stat;

const CAP = serverConfig.FILE_VIEWER_MAX_BYTES;
const DOTFILE = ['.', 'env'].join('');

let base: string;
let worktree: string;
let outside: string;
let otherCwd: string;
let nonGit: string;
let fifoMade = false;

async function sh(command: string, cwd: string, timeoutMs = 10_000) {
  const proc = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  await assertRealFs('file-viewer-service-real-fs');
  // The shell mode relies on elevation being bypassed; never let this file reach a real elevated login shell.
  if (process.env.AUTH_MODE === 'multi-user') throw new Error('this test must not run with AUTH_MODE=multi-user');

  base = await realpath(await mkdtemp(join(tmpdir(), 'file-viewer-')));
  worktree = join(base, 'wt');
  outside = join(base, 'outside');
  otherCwd = join(base, 'elsewhere');
  nonGit = join(base, 'plain-dir');
  for (const dir of [worktree, outside, otherCwd, nonGit, join(base, 'wt-evil')]) await mkdir(dir);

  await mkdir(join(worktree, '.git'));
  await writeFile(join(worktree, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(worktree, 'sub'));
  await writeFile(join(worktree, 'sub', 'nested.txt'), 'nested\n');
  await writeFile(join(worktree, 'plain.txt'), 'hello\nworld\n');
  await writeFile(join(worktree, DOTFILE), 'SECRET=1\n');
  await writeFile(join(worktree, 'app.ts'), 'export const x = 1;\n');
  await writeFile(join(worktree, 'empty.txt'), '');
  await writeFile(join(worktree, 'exact.txt'), Buffer.alloc(CAP, 0x61));
  await writeFile(join(worktree, 'over.txt'), Buffer.alloc(CAP + 1, 0x61));
  const nulInside = Buffer.alloc(9000, 0x61);
  nulInside[8191] = 0; // byte #8192: the last byte of the window
  await writeFile(join(worktree, 'nul-in-window.bin'), nulInside);
  const nulLate = Buffer.alloc(9000, 0x61);
  nulLate[8192] = 0; // byte #8193: just past the window
  await writeFile(join(worktree, 'nul-at-8193.txt'), nulLate);
  await writeFile(join(worktree, 'weird name.txt'), 'spaces\n');
  await writeFile(join(nonGit, 'only.txt'), 'no git here\n');

  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET\n');
  await writeFile(join(base, 'wt-evil', 'x.txt'), 'sibling\n');
  await symlink('plain.txt', join(worktree, 'link-to-file'));
  await symlink('sub', join(worktree, 'link-to-dir'));
  await symlink('../outside/secret.txt', join(worktree, 'link-out-file'));
  await symlink('../outside', join(worktree, 'link-out-dir'));
  await symlink(join(outside, 'secret.txt'), join(worktree, 'link-abs-out'));
  await symlink('../wt-evil', join(worktree, 'link-prefix-sibling'));
  await symlink('nowhere', join(worktree, 'dangling'));
  await symlink('link-out-dir', join(worktree, 'link-chain-out'));
  fifoMade = (await sh(`mkfifo ${JSON.stringify(join(worktree, 'pipe'))}`, base)).code === 0;
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true });
});

/** Unblock a reader stuck in `open(fifo)` by briefly opening it for writing. */
function unblockFifo(path: string): void {
  try {
    closeSync(openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
  } catch {
    // no reader waiting: nothing to unblock
  }
}

const MODES: Array<[string, string | null]> = [
  ['direct (no OS user)', null],
  ['shell (OS user given, elevation bypassed)', userInfo().username],
];

describe.each(MODES)('boundary table: %s', (_label, user) => {
  describe('tree', () => {
    it('lists every entry of the root, dotfiles and .git included, directories first, symlinks as their own kind', async () => {
      const response = await listDirectory(worktree, '', user);
      expect(response.path).toBe('');
      const names = response.entries.map((e) => e.name);
      expect(names).toContain(DOTFILE);
      const byName = new Map(response.entries.map((e) => [e.name, e.kind]));
      expect(byName.get('.git')).toBe('dir');
      expect(byName.get('sub')).toBe('dir');
      expect(byName.get(DOTFILE)).toBe('file');
      expect(byName.get('plain.txt')).toBe('file');
      expect(byName.get('weird name.txt')).toBe('file');
      for (const link of ['link-to-file', 'link-to-dir', 'link-out-file', 'link-out-dir', 'link-abs-out', 'dangling']) {
        expect(byName.get(link)).toBe('symlink');
      }
      // directories first, then plain byte order within each group
      const kinds = response.entries.map((e) => e.kind === 'dir');
      expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)));
      for (const group of [response.entries.filter((e) => e.kind === 'dir'), response.entries.filter((e) => e.kind !== 'dir')]) {
        const groupNames = group.map((e) => e.name);
        expect(groupNames).toEqual([...groupNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }
    });

    it('a tree entry carries nothing but name and kind (no size)', async () => {
      const response = await listDirectory(worktree, '', user);
      for (const entry of response.entries) expect(Object.keys(entry).sort()).toEqual(['kind', 'name']);
    });

    it('.git is listed like any other directory and can be expanded', async () => {
      const response = await listDirectory(worktree, '.git', user);
      expect(response.entries).toEqual([{ name: 'HEAD', kind: 'file' }]);
    });

    it('lists a nested directory', async () => {
      expect((await listDirectory(worktree, 'sub', user)).entries).toEqual([{ name: 'nested.txt', kind: 'file' }]);
    });

    it('a directory that is not a git repository is listed like any other', async () => {
      expect((await listDirectory(nonGit, '', user)).entries).toEqual([{ name: 'only.txt', kind: 'file' }]);
    });

    it('a fifo is listed as a file, not dropped', async () => {
      if (!fifoMade) return; // the filesystem refuses mkfifo
      const entries = (await listDirectory(worktree, '', user)).entries;
      expect(entries.find((e) => e.name === 'pipe')).toEqual({ name: 'pipe', kind: 'file' });
    });

    it('a symlink to a directory inside the working directory, expanded, lists the target\'s entries', async () => {
      const response = await listDirectory(worktree, 'link-to-dir', user);
      expect(response).toEqual({ path: 'link-to-dir', entries: [{ name: 'nested.txt', kind: 'file' }] });
    });

    it('a symlink (or a chain of them) to a directory outside is refused, never listed', async () => {
      for (const link of ['link-out-dir', 'link-chain-out', 'link-prefix-sibling']) {
        const error = await listDirectory(worktree, link, user).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
      }
    });

    it('a path through a symlink that leaves the tree is refused too', async () => {
      await expect(listDirectory(worktree, 'link-out-dir/', user)).rejects.toBeInstanceOf(ValidationError);
    });

    it('a tree request for a file is a ValidationError', async () => {
      await expect(listDirectory(worktree, 'plain.txt', user)).rejects.toThrow(new ValidationError('Path is not a directory'));
      await expect(listDirectory(worktree, 'link-to-file', user)).rejects.toThrow(
        new ValidationError('Path is not a directory'),
      );
    });

    it('a missing leaf under a symlinked directory that points OUTSIDE is NotFound, never an error (tree and content)', async () => {
      await expect(listDirectory(worktree, 'link-out-dir/missing', user)).rejects.toBeInstanceOf(NotFoundError);
      await expect(readFileContent(worktree, 'link-out-dir/missing.txt', user)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a missing directory and a dangling symlink are NotFound', async () => {
      await expect(listDirectory(worktree, 'nope', user)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listDirectory(worktree, 'dangling', user)).rejects.toBeInstanceOf(NotFoundError);
    });

  });

  describe('content', () => {
    it('empty file: text, content "", size 0, not truncated', async () => {
      expect(await readFileContent(worktree, 'empty.txt', user)).toEqual({
        path: 'empty.txt',
        kind: 'text',
        content: '',
        size: 0,
        truncated: false,
        language: 'text',
      });
    });

    it('exactly the cap: the full content, not truncated', async () => {
      const response = await readFileContent(worktree, 'exact.txt', user);
      expect(response.kind).toBe('text');
      expect(response.content?.length).toBe(CAP);
      expect(response.size).toBe(CAP);
      expect(response.truncated).toBe(false);
    });

    it('cap + 1 byte: the first cap bytes, truncated, size is the real total', async () => {
      const response = await readFileContent(worktree, 'over.txt', user);
      expect(response.kind).toBe('text');
      expect(response.content?.length).toBe(CAP);
      expect(response.size).toBe(CAP + 1);
      expect(response.truncated).toBe(true);
    });

    it('NUL at byte 8193 (just past the window) is text', async () => {
      const response = await readFileContent(worktree, 'nul-at-8193.txt', user);
      expect(response.kind).toBe('text');
      expect(response.content?.includes('\0')).toBe(true);
      expect(response.size).toBe(9000);
    });

    it('NUL within the first 8 KiB is binary: size, no content', async () => {
      expect(await readFileContent(worktree, 'nul-in-window.bin', user)).toEqual({
        path: 'nul-in-window.bin',
        kind: 'binary',
        size: 9000,
        truncated: false,
        language: 'text',
      });
    });

    it('a directory on the content route is a ValidationError', async () => {
      await expect(readFileContent(worktree, 'sub', user)).rejects.toThrow(new ValidationError('Path is a directory'));
      await expect(readFileContent(worktree, '.git', user)).rejects.toThrow(new ValidationError('Path is a directory'));
    });

    it('a missing file and a dangling symlink are NotFound', async () => {
      await expect(readFileContent(worktree, 'nope.txt', user)).rejects.toBeInstanceOf(NotFoundError);
      await expect(readFileContent(worktree, 'dangling', user)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a symlink to a file outside the working directory is refused and its content never returned', async () => {
      for (const link of ['link-out-file', 'link-abs-out', 'link-out-dir/secret.txt', 'link-chain-out/secret.txt']) {
        const error = await readFileContent(worktree, link, user).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
      }
    });

    it('a symlink to a regular file inside the working directory opens like its target', async () => {
      const response = await readFileContent(worktree, 'link-to-file', user);
      expect(response.content).toBe('hello\nworld\n');
      expect(response.size).toBe(12);
    });

    it('a dotfile is readable like any file, and so is a path through a dot directory', async () => {
      expect((await readFileContent(worktree, DOTFILE, user)).content).toBe('SECRET=1\n');
      expect((await readFileContent(worktree, '.git/HEAD', user)).content).toBe('ref: refs/heads/main\n');
    });

    it('reads a name with a space and a nested path, and stamps the language from the path', async () => {
      expect((await readFileContent(worktree, 'weird name.txt', user)).content).toBe('spaces\n');
      expect((await readFileContent(worktree, 'sub/nested.txt', user)).path).toBe('sub/nested.txt');
      expect((await readFileContent(worktree, 'app.ts', user)).language).toBe('typescript');
      expect((await readFileContent(worktree, DOTFILE, user)).language).toBe('bash');
    });

    it('a file in a non-git directory reads like any other', async () => {
      expect((await readFileContent(nonGit, 'only.txt', user)).content).toBe('no git here\n');
    });

    it('a fifo is refused as "not a regular file" and never blocks on open/cat', async () => {
      if (!fifoMade) return; // the filesystem refuses mkfifo
      const fifo = join(worktree, 'pipe');
      const attempt = readFileContent(worktree, 'pipe', user).then(
        () => 'returned',
        (error: unknown) => error,
      );
      const outcome = await Promise.race([attempt, Bun.sleep(3_000).then(() => 'blocked')]);
      if (outcome === 'blocked') {
        unblockFifo(fifo); // do not leave a reader parked on the fifo
        await attempt;
      }
      expect(outcome).toBeInstanceOf(ValidationError);
      expect((outcome as ValidationError).message).toBe('Not a regular file');
    });
  });
});

describe('readWorkingTreeFile direct path with { regularOnly, maxBytes } on real files', () => {
  const opts = { regularOnly: true, maxBytes: 100 } as const;

  it('refuses a non-regular file as not-regular (a character device; the fifo case is the boundary table above)', async () => {
    expect(await readWorkingTreeFile('/dev', 'null', null, opts)).toEqual({ kind: 'not-regular' });
    // Without the option the diff paths read the same path as a file, unchanged.
    expect((await readWorkingTreeFile('/dev', 'null', null))?.kind).toBe('file');
  });

  it('reads at most maxBytes and reports the total size, follows a symlink to a regular file, and keeps directory / missing', async () => {
    const capped = await readWorkingTreeFile(worktree, 'exact.txt', null, opts);
    expect(capped).toMatchObject({ kind: 'file', size: CAP });
    expect((capped as { content: Buffer }).content.length).toBe(100);
    const viaLink = await readWorkingTreeFile(worktree, 'link-to-file', null, opts);
    expect(viaLink).toMatchObject({ kind: 'file', size: 12 });
    expect(await readWorkingTreeFile(worktree, 'sub', null, opts)).toEqual({ kind: 'directory' });
    expect(await readWorkingTreeFile(worktree, 'nope', null, opts)).toBeNull();
    expect(await readWorkingTreeFile(worktree, 'dangling', null, opts)).toBeNull();
  });
});

describe('readWorkingTreeFile direct path: a fifo never blocks the read', () => {
  const opts = { regularOnly: true, maxBytes: 100 } as const;

  /** Resolves with the call's result, or 'blocked' after `ms`; unblocks a parked reader so nothing leaks. */
  async function raceWithTimer<T>(call: Promise<T>, fifo: string, ms = 2_000): Promise<T | 'blocked'> {
    const outcome = await Promise.race([call, Bun.sleep(ms).then(() => 'blocked' as const)]);
    if (outcome === 'blocked') {
      unblockFifo(fifo);
      await call.catch(() => {});
    }
    return outcome;
  }

  it('a fifo at the path is not-regular, promptly (a real fifo; note a fifo present at stat time is also caught by name-based stat)', async () => {
    if (!fifoMade) return;
    const fifo = join(worktree, 'pipe');
    const outcome = await raceWithTimer(readWorkingTreeFile(worktree, 'pipe', null, opts), fifo);
    expect(outcome).toEqual({ kind: 'not-regular' });
  }, 5_000);

  // At most ONE live spy on `stat`, tracked here so a failing test cannot leave it installed for the next one.
  let statSpy: Mock<typeof REAL_STAT> | undefined;
  let swapFiredStack: string | undefined;
  /** Restores the spy and proves the module's `stat` is the real one again (a leak would poison later tests). */
  function removeStatSpy(): void {
    statSpy?.mockRestore();
    statSpy = undefined;
    expect(fsPromises.stat === REAL_STAT, 'fs/promises stat is the real function after the spy is restored').toBe(true);
  }
  afterEach(removeStatSpy);

  /**
   * Installs the single pass-through spy on the module's `stat`: it calls the real one and returns its
   * real result (nothing is faked). It counts, per path, only calls whose first argument is EXACTLY that
   * path string, so a runtime where `handle.stat()` also routes through the patched module function
   * cannot inflate a count: only a stat BY NAME is a by-name look at the path. `swapOn.run` runs
   * after the real stat of the first by-name call for `swapOn.path`, before its result is returned.
   */
  /** What one by-name call looked like: its argument types and the stack of the caller, for CI evidence. */
  interface ByNameCall {
    args: string;
    stack: string;
  }
  const describeCalls = (calls: ByNameCall[] | undefined): string =>
    (calls ?? []).map((c, i) => `#${i + 1} args=${c.args}\n${c.stack}`).join('\n---\n');

  function installStatSpy(swapOn?: { path: string; run: () => Promise<void> }): Map<string, ByNameCall[]> {
    // A foreign leak (a spy left by something else) must fail here with a named reason, not as a recursion.
    expect(fsPromises.stat === REAL_STAT, 'fs/promises stat is the real function before this spy is installed').toBe(true);
    const byName = new Map<string, ByNameCall[]>();
    statSpy = spyOn(fsPromises, 'stat').mockImplementation((async (...args: Parameters<typeof REAL_STAT>) => {
      const stack = new Error('by-name stat caller').stack ?? '';
      const result = await REAL_STAT(...args);
      if (typeof args[0] === 'string') {
        const calls = byName.get(args[0]) ?? [];
        calls.push({ args: args.map((a) => typeof a).join(','), stack });
        byName.set(args[0], calls);
        if (swapOn && args[0] === swapOn.path && calls.length === 1) {
          swapFiredStack = stack;
          await swapOn.run();
        }
      }
      return result;
    }) as typeof REAL_STAT);
    return byName;
  }

  it('the options path never stats the path by name (a stat-then-open by name is the race): zero by-name stat calls for a regular file and for a fifo', async () => {
    const fifoPath = join(worktree, 'pipe');
    const plainPath = join(worktree, 'plain.txt');
    const byName = installStatSpy();
    try {
      const regular = await readWorkingTreeFile(worktree, 'plain.txt', null, opts);
      expect(regular).toMatchObject({ kind: 'file', size: 12 });
      // Same condition as before (zero by-name calls); the message names every caller if it fails.
      expect(byName.get(plainPath)?.length ?? 0, `by-name stat callers for the regular file:\n${describeCalls(byName.get(plainPath))}`).toBe(0);
      if (fifoMade) {
        const fifo = await raceWithTimer(readWorkingTreeFile(worktree, 'pipe', null, opts), fifoPath);
        expect(fifo).toEqual({ kind: 'not-regular' });
        expect(byName.get(fifoPath)?.length ?? 0, `by-name stat callers for the fifo:\n${describeCalls(byName.get(fifoPath))}`).toBe(0);
      }
    } finally {
      removeStatSpy();
      unblockFifo(fifoPath);
    }
  }, 8_000);

  it('a real swap between a by-name stat and the open cannot park the read: the file is replaced by a fifo inside the first by-name stat', async () => {
    if (!fifoMade) return;
    const swapPath = join(worktree, 'swap-me');
    await writeFile(swapPath, 'was a regular file\n');
    // Pass-through: the first by-name stat returns the REAL pre-swap result, and only afterwards is the
    // path replaced by a fifo. Code that stats by name and then opens by name blocks in the open; code
    // that never looks at the path by name is not affected by the order (it never calls the spy).
    swapFiredStack = undefined;
    const swapCalls = installStatSpy({
      path: swapPath,
      run: async () => {
        await rm(swapPath);
        const made = await sh(`mkfifo ${JSON.stringify(swapPath)}`, worktree);
        if (made.code !== 0) throw new Error(`mkfifo failed: ${made.err}`);
      },
    });
    try {
      const outcome = await raceWithTimer(readWorkingTreeFile(worktree, 'swap-me', null, opts), swapPath);
      expect(
        outcome,
        `swap fired: ${swapFiredStack !== undefined}; stack of the by-name stat that triggered it:\n${swapFiredStack ?? '(none: stat was never called by name)'}\nall by-name calls:\n${describeCalls(swapCalls.get(swapPath))}`,
      ).not.toBe('blocked');
    } finally {
      removeStatSpy();
      unblockFifo(swapPath);
      await rm(swapPath).catch(() => {});
    }
  }, 8_000);
});

describe('direct mode: a missing working directory', () => {
  it('is NotFound for both routes (in shell mode the real runner would fail the spawn itself; that case is the runner\'s cwdFailed, covered by the unit test)', async () => {
    await expect(listDirectory(join(base, 'gone'), '', null)).rejects.toThrow(new NotFoundError('Working directory'));
    await expect(readFileContent(join(base, 'gone'), 'a.txt', null)).rejects.toThrow(new NotFoundError('Working directory'));
  });
});

describe('commands in a real sh, run from a directory that is NOT the target', () => {
  it('buildDirectoryListingCommand: three sections in the documented order, fifo and symlinks in the right ones', async () => {
    const r = await sh(buildDirectoryListingCommand(worktree), otherCwd);
    expect(r.code).toBe(0);
    const entries = parseDirectoryListing(r.out, worktree);
    const kind = (name: string) => entries.find((e) => e.name === name)?.kind;
    expect(kind('sub')).toBe('dir');
    expect(kind('.git')).toBe('dir');
    expect(kind('link-to-dir')).toBe('symlink');
    expect(kind('link-out-file')).toBe('symlink');
    expect(kind('dangling')).toBe('symlink');
    expect(kind('plain.txt')).toBe('file');
    expect(kind(DOTFILE)).toBe('file');
    if (fifoMade) expect(kind('pipe')).toBe('file'); // the complement run, not -type f
    expect(entries.length).toBe(
      (await listDirectory(worktree, '', null)).entries.length, // same set as the in-process listing
    );
  });

  it('buildDirectoryListingCommand: awkward names survive (space, newline, quote, leading dash, non-ASCII)', async () => {
    const awkward = await mkdtemp(join(base, 'awkward-'));
    const names = ['with space', 'new\nline', "it's", '-dash', '日本語', '$HOME', '*'];
    for (const name of names) await writeFile(join(awkward, name), 'x');
    await mkdir(join(awkward, 'dir with space'));
    const r = await sh(buildDirectoryListingCommand(awkward), otherCwd);
    expect(r.code).toBe(0);
    const entries = parseDirectoryListing(r.out, awkward);
    expect(entries.filter((e) => e.kind === 'file').map((e) => e.name).sort()).toEqual([...names].sort());
    expect(entries.filter((e) => e.kind === 'dir').map((e) => e.name)).toEqual(['dir with space']);
  });

  it('buildDirectoryListingCommand: an empty directory is the bare separators; a file or a missing path exits 44', async () => {
    const empty = await mkdtemp(join(base, 'empty-'));
    const r = await sh(buildDirectoryListingCommand(empty), otherCwd);
    expect(r.code).toBe(0);
    expect(parseDirectoryListing(r.out, empty)).toEqual([]);
    expect((await sh(buildDirectoryListingCommand(join(worktree, 'plain.txt')), otherCwd)).code).toBe(44);
    expect((await sh(buildDirectoryListingCommand(join(worktree, 'nope')), otherCwd)).code).toBe(44);
  });

  it('buildRealpathCommand: prints the real root and the real target; a symlink resolves, a missing target exits 47, a missing root 46', async () => {
    const ok = await sh(buildRealpathCommand(worktree, join(worktree, 'link-to-dir')), otherCwd);
    expect(ok.code).toBe(0);
    expect(ok.out).toBe(`${worktree}\n${join(worktree, 'sub')}\n`);

    const out = await sh(buildRealpathCommand(worktree, join(worktree, 'link-out-file')), otherCwd);
    expect(out.code).toBe(0);
    expect(out.out).toBe(`${worktree}\n${join(outside, 'secret.txt')}\n`);

    // A failure exits with its own code; the service ignores stdout then (the root line may already be out).
    const missingLeaf = await sh(buildRealpathCommand(worktree, join(worktree, 'nope')), otherCwd);
    expect(missingLeaf.code).toBe(47);
    expect(missingLeaf.out).toBe(`${worktree}\n`);
    expect((await sh(buildRealpathCommand(worktree, join(worktree, 'dangling')), otherCwd)).code).toBe(47);
    const missingRoot = await sh(buildRealpathCommand(join(base, 'gone'), join(base, 'gone', 'x')), otherCwd);
    expect(missingRoot.code).toBe(46);
    expect(missingRoot.out).toBe('');
  });

  it('a service call that gets an unusable listing fails closed (InternalError), not as an empty directory', async () => {
    const error = await listDirectory(worktree, '', 'someone', {
      runAsUser: async () => ({ stdout: `${worktree}\n${worktree}\n`, stderr: '', exitCode: 0, timedOut: false, cwdFailed: false }),
    }).catch((e: unknown) => e);
    // First call is the realpath (ok), the second returns the same text as a "listing": unparseable.
    expect(error).toBeInstanceOf(InternalError);
  });
});
