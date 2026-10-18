/**
 * Unit tests for the file viewer service: the exact commands it hands to the
 * elevation runner, the parsing of their output, the order of the calls
 * (containment is decided BEFORE a read or a listing uses the path) and the
 * mapping of every read outcome to a response or an error.
 *
 * Everything runs through the `FileViewerDeps` seams with fakes, so nothing
 * here touches a real filesystem or spawns a process. The behaviour of the
 * commands themselves in a real shell, and the boundary table against real
 * files (symlinks, fifos), lives in `file-viewer-service-real-fs.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { shellEscape, type RunAsUserOpts, type RunAsUserResult } from '../privilege-elevation.js';
import { InternalError, NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  buildDirectoryListingCommand,
  buildRealpathCommand,
  parseDirectoryListing,
  listDirectory,
  readFileContent,
  FILE_VIEWER_BINARY_PROBE_BYTES,
  type FileViewerDeps,
} from '../file-viewer-service.js';

const ROOT = '/home/alice/wt';

function result(partial: Partial<RunAsUserResult> = {}): RunAsUserResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false, ...partial };
}

/** A runAsUser fake that answers each call from `responses` in order and records the calls. */
function fakeRunner(responses: Array<RunAsUserResult | Error>) {
  const calls: RunAsUserOpts[] = [];
  const runAsUser: FileViewerDeps['runAsUser'] = async (opts) => {
    calls.push(opts);
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected runAsUser call #${calls.length}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, runAsUser };
}

/** `realpath` stdout: the real root, then the real target. */
const realpathOut = (root: string, target: string) => result({ stdout: `${root}\n${target}\n` });

describe('buildDirectoryListingCommand', () => {
  it('is a directory probe then three portable find runs, separated by two NULs, on one escaped absolute path', () => {
    const dir = "/home/alice/wt/it's a dir";
    const e = shellEscape(dir);
    expect(buildDirectoryListingCommand(dir)).toBe(
      `test -d ${e} || exit 44; ` +
        `find ${e} -mindepth 1 -maxdepth 1 -type d -print0; printf '\\000\\000'; ` +
        `find ${e} -mindepth 1 -maxdepth 1 -type l -print0; printf '\\000\\000'; ` +
        `find ${e} -mindepth 1 -maxdepth 1 ! -type d ! -type l -print0`,
    );
  });

  it('uses only the BSD/GNU-portable find subset (no -printf, no -L, no -H, no -type f)', () => {
    const command = buildDirectoryListingCommand('/x');
    expect(command).not.toContain('-printf');
    expect(command).not.toContain('-L');
    expect(command).not.toContain('-H');
    expect(command).not.toContain('-type f');
  });

  it('is single-line (a newline would collapse inside the elevated login shell)', () => {
    expect(buildDirectoryListingCommand('/x')).not.toContain('\n');
  });
});

describe('buildRealpathCommand', () => {
  it('resolves the root, requires the target to exist, then prints both real paths -- all absolute', () => {
    const root = shellEscape('/home/alice/wt');
    const target = shellEscape("/home/alice/wt/it's");
    expect(buildRealpathCommand('/home/alice/wt', "/home/alice/wt/it's")).toBe(
      `r=$(test -d ${root} && realpath -- ${root}) || exit 46; test -e ${target} || exit 47; printf '%s\\n' "$r"; realpath -- ${target}`,
    );
  });

  it('is single-line', () => {
    expect(buildRealpathCommand('/a', '/a/b')).not.toContain('\n');
  });
});

describe('parseDirectoryListing', () => {
  const dir = '/r/d';
  const p = (...names: string[]) => names.map((n) => `${dir}/${n}\0`).join('');
  const SEP = '\0\0';

  it('maps the three sections to dir, symlink and file', () => {
    const out = p('sub') + SEP + p('link') + SEP + p('a.txt', 'b.txt');
    expect(parseDirectoryListing(out, dir)).toEqual([
      { name: 'sub', kind: 'dir' },
      { name: 'link', kind: 'symlink' },
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
    ]);
  });

  it('an empty directory is just the two separators', () => {
    expect(parseDirectoryListing(SEP + SEP, dir)).toEqual([]);
  });

  it('empty leading and middle sections do not shift the later ones (three NULs in a row are a terminator plus a separator)', () => {
    expect(parseDirectoryListing(SEP + SEP + p('f'), dir)).toEqual([{ name: 'f', kind: 'file' }]);
    expect(parseDirectoryListing(SEP + p('l') + SEP, dir)).toEqual([{ name: 'l', kind: 'symlink' }]);
    expect(parseDirectoryListing(p('d') + SEP + SEP, dir)).toEqual([{ name: 'd', kind: 'dir' }]);
  });

  it('keeps names with spaces, newlines, a leading dash, a dot prefix and non-ASCII characters', () => {
    const names = ['with space', 'new\nline', '-dash', '.hidden', '日本語', "it's"];
    const parsed = parseDirectoryListing(SEP + SEP + p(...names), dir);
    expect(parsed.map((e) => e.name)).toEqual(names);
  });

  it('fails closed on a malformed stream', () => {
    const wellFormed = p('d') + SEP + p('l') + SEP + p('f');
    expect(() => parseDirectoryListing(wellFormed, dir)).not.toThrow();
    // no final terminator
    expect(() => parseDirectoryListing(wellFormed.slice(0, -1), dir)).toThrow();
    // a lone (unpaired) separator NUL
    expect(() => parseDirectoryListing(p('d') + '\0' + p('f'), dir)).toThrow();
    // too few sections
    expect(() => parseDirectoryListing(p('d') + SEP + p('l'), dir)).toThrow();
    // too many sections
    expect(() => parseDirectoryListing(wellFormed + SEP + p('x'), dir)).toThrow();
    // an entry that is not under the listed directory
    expect(() => parseDirectoryListing(SEP + SEP + '/elsewhere/f\0', dir)).toThrow();
    // nothing at all
    expect(() => parseDirectoryListing('', dir)).toThrow();
  });
});

describe('listDirectory (elevated: another OS user owns the working directory)', () => {
  const listing =
    `${ROOT}/src\0${ROOT}/.git\0` + '\0\0' + `${ROOT}/link\0` + '\0\0' + `${ROOT}/README.md\0${ROOT}/.zshrc\0${ROOT}/Zebra\0`;

  it('resolves the real path first, then lists THAT absolute path; both calls run as the owner with the cwd and a timeout', async () => {
    const { calls, runAsUser } = fakeRunner([realpathOut(ROOT, ROOT), result({ stdout: listing })]);
    const response = await listDirectory(ROOT, '', 'alice', { runAsUser });

    expect(calls.map((c) => c.command)).toEqual([
      buildRealpathCommand(ROOT, ROOT),
      buildDirectoryListingCommand(ROOT),
    ]);
    for (const call of calls) {
      expect(call.username).toBe('alice');
      expect(call.cwd).toBe(ROOT);
      expect(call.timeoutMs).toBe(30_000);
    }
    expect(response.path).toBe('');
  });

  it('sorts directories first, then by plain byte order (uppercase before lowercase, dot before letters), symlinks among files', async () => {
    const { runAsUser } = fakeRunner([realpathOut(ROOT, ROOT), result({ stdout: listing })]);
    const response = await listDirectory(ROOT, '', 'alice', { runAsUser });
    expect(response.entries).toEqual([
      { name: '.git', kind: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: '.zshrc', kind: 'file' },
      { name: 'README.md', kind: 'file' },
      { name: 'Zebra', kind: 'file' },
      { name: 'link', kind: 'symlink' },
    ]);
  });

  it('lists the symlink-resolved directory, not the lexical path (a link inside the tree works like its target)', async () => {
    const real = `${ROOT}/real-dir`;
    const { calls, runAsUser } = fakeRunner([
      realpathOut(ROOT, real),
      result({ stdout: `\0\0\0\0${real}/f\0` }),
    ]);
    const response = await listDirectory(ROOT, 'link-to-dir', 'alice', { runAsUser });
    expect(calls[0].command).toBe(buildRealpathCommand(ROOT, `${ROOT}/link-to-dir`));
    expect(calls[1].command).toBe(buildDirectoryListingCommand(real));
    expect(response).toEqual({ path: 'link-to-dir', entries: [{ name: 'f', kind: 'file' }] });
  });

  it('refuses a target whose real path is outside the working directory and never lists it', async () => {
    const { calls, runAsUser } = fakeRunner([realpathOut(ROOT, '/etc')]);
    const error = await listDirectory(ROOT, 'escape', 'alice', { runAsUser }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(calls.length).toBe(1);
  });

  it('a sibling directory that merely shares the root as a string prefix is outside', async () => {
    const { calls, runAsUser } = fakeRunner([realpathOut(ROOT, `${ROOT}-evil`)]);
    await expect(listDirectory(ROOT, 'x', 'alice', { runAsUser })).rejects.toBeInstanceOf(ValidationError);
    expect(calls.length).toBe(1);
  });

  it('maps the command exit codes: root gone, target missing, target not a directory', async () => {
    await expect(
      listDirectory(ROOT, 'x', 'alice', { runAsUser: fakeRunner([result({ exitCode: 46 })]).runAsUser }),
    ).rejects.toThrow(new NotFoundError('Working directory'));
    await expect(
      listDirectory(ROOT, 'x', 'alice', { runAsUser: fakeRunner([result({ exitCode: 47 })]).runAsUser }),
    ).rejects.toThrow(new NotFoundError('Directory'));
    await expect(
      listDirectory(ROOT, 'file.txt', 'alice', {
        runAsUser: fakeRunner([realpathOut(ROOT, `${ROOT}/file.txt`), result({ exitCode: 44 })]).runAsUser,
      }),
    ).rejects.toThrow(new ValidationError('Path is not a directory'));
  });

  it('maps runner failures (cwd unavailable, timeout, spawn failure, other exit codes, malformed output) without leaking detail', async () => {
    const cases: Array<[Array<RunAsUserResult | Error>, unknown]> = [
      [[result({ cwdFailed: true, exitCode: 125 })], NotFoundError],
      [[result({ timedOut: true, exitCode: 137 })], InternalError],
      [[new Error('sudo exploded: secret detail')], InternalError],
      [[result({ exitCode: 127, stderr: 'realpath: not found' })], InternalError],
      [[result({ stdout: `${ROOT}\n/x\n/y\n` })], InternalError], // a path containing a newline
      [[result({ stdout: `${ROOT}\n` })], InternalError],
      [[realpathOut(ROOT, ROOT), result({ exitCode: 2, stderr: 'find: boom' })], InternalError],
      [[realpathOut(ROOT, ROOT), result({ stdout: 'garbage' })], InternalError],
    ];
    for (const [responses, expected] of cases) {
      const error = await listDirectory(ROOT, '', 'alice', { runAsUser: fakeRunner(responses).runAsUser }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(expected as typeof Error);
      expect((error as Error).message).not.toContain('secret detail');
      expect((error as Error).message).not.toContain('boom');
    }
  });
});

describe('listDirectory / readFileContent: lexical guard runs before anything else', () => {
  it.each(['../x', 'a/../b', '/etc', 'a\0b', 'a..b'])('%j is refused without touching the runner', async (bad) => {
    const { calls, runAsUser } = fakeRunner([]);
    await expect(listDirectory(ROOT, bad, 'alice', { runAsUser })).rejects.toBeInstanceOf(ValidationError);
    await expect(readFileContent(ROOT, bad, 'alice', { runAsUser })).rejects.toBeInstanceOf(ValidationError);
    expect(calls.length).toBe(0);
  });

  it('the content route needs a non-empty path (the tree route takes the empty string as the root)', async () => {
    const { calls, runAsUser } = fakeRunner([]);
    await expect(readFileContent(ROOT, '', 'alice', { runAsUser })).rejects.toBeInstanceOf(ValidationError);
    expect(calls.length).toBe(0);
  });
});

describe('readFileContent', () => {
  const CAP = 100;

  type ReadArgs = Parameters<FileViewerDeps['readWorkingTreeFile']>;
  type ReadOutcome = Awaited<ReturnType<FileViewerDeps['readWorkingTreeFile']>>;

  /** A read fake that records its calls; the realpath runner answers "inside the root". */
  function harness(read: ReadOutcome | (() => never)) {
    const order: string[] = [];
    const readCalls: ReadArgs[] = [];
    const runner = fakeRunner([realpathOut(ROOT, `${ROOT}/f`)]);
    const deps: Partial<FileViewerDeps> = {
      maxBytes: CAP,
      runAsUser: async (opts) => {
        order.push('realpath');
        return runner.runAsUser(opts);
      },
      readWorkingTreeFile: (async (...args: ReadArgs) => {
        order.push('read');
        readCalls.push(args);
        return typeof read === 'function' ? read() : read;
      }) as FileViewerDeps['readWorkingTreeFile'],
    };
    return { deps, order, readCalls, runner };
  }

  const file = (content: Buffer, size = content.length): ReadOutcome => ({ kind: 'file', content, size });

  it('decides containment first, then reads the lexical path as the owner with regularOnly and the cap', async () => {
    const { deps, order, readCalls } = harness(file(Buffer.from('hi')));
    await readFileContent(ROOT, 'src/a.ts', 'alice', deps);
    expect(order).toEqual(['realpath', 'read']);
    expect(readCalls).toEqual([[ROOT, 'src/a.ts', 'alice', { regularOnly: true, maxBytes: CAP }]]);
  });

  it('a target outside the working directory is refused and the read never happens', async () => {
    const order: string[] = [];
    const runner = fakeRunner([realpathOut(ROOT, '/etc/passwd')]);
    const deps: Partial<FileViewerDeps> = {
      runAsUser: runner.runAsUser,
      readWorkingTreeFile: (async () => {
        order.push('read');
        return null;
      }) as FileViewerDeps['readWorkingTreeFile'],
    };
    await expect(readFileContent(ROOT, 'link-out', 'alice', deps)).rejects.toBeInstanceOf(ValidationError);
    expect(order).toEqual([]);
  });

  it('maps a missing file to NotFound, a directory and a non-regular file to ValidationError', async () => {
    await expect(readFileContent(ROOT, 'f', 'alice', harness(null).deps)).rejects.toThrow(new NotFoundError('File'));
    await expect(readFileContent(ROOT, 'f', 'alice', harness({ kind: 'directory' }).deps)).rejects.toThrow(
      new ValidationError('Path is a directory'),
    );
    await expect(readFileContent(ROOT, 'f', 'alice', harness({ kind: 'not-regular' }).deps)).rejects.toThrow(
      new ValidationError('Not a regular file'),
    );
  });

  it('empty file: text with empty content, size 0, not truncated', async () => {
    const response = await readFileContent(ROOT, 'empty.txt', 'alice', harness(file(Buffer.alloc(0))).deps);
    expect(response).toEqual({ path: 'empty.txt', kind: 'text', content: '', size: 0, truncated: false, language: 'text' });
  });

  it('exactly the cap: full content, not truncated', async () => {
    const response = await readFileContent(ROOT, 'a.ts', 'alice', harness(file(Buffer.alloc(CAP, 0x61))).deps);
    expect(response.kind).toBe('text');
    expect(response.content?.length).toBe(CAP);
    expect(response.truncated).toBe(false);
    expect(response.size).toBe(CAP);
    expect(response.language).toBe('typescript');
  });

  it('one byte over the cap: the first cap bytes, truncated, size is the real total', async () => {
    const response = await readFileContent(ROOT, 'a.ts', 'alice', harness(file(Buffer.alloc(CAP, 0x61), CAP + 1)).deps);
    expect(response.content?.length).toBe(CAP);
    expect(response.truncated).toBe(true);
    expect(response.size).toBe(CAP + 1);
  });

  it('truncation follows the reported size, not the length of what came back', async () => {
    // Fewer bytes than the cap came back (e.g. the elevated path re-encoded invalid bytes),
    // but the file is far bigger than the cap: still truncated.
    const response = await readFileContent(ROOT, 'a.txt', 'alice', harness(file(Buffer.from('short'), 5000)).deps);
    expect(response.truncated).toBe(true);
    expect(response.size).toBe(5000);
  });

  it('NUL just inside the 8 KiB window is binary: no content, size reported, never truncated', async () => {
    const bytes = Buffer.alloc(FILE_VIEWER_BINARY_PROBE_BYTES + 10, 0x61);
    bytes[FILE_VIEWER_BINARY_PROBE_BYTES - 1] = 0; // byte #8192
    const response = await readFileContent(ROOT, 'x.bin', 'alice', harness(file(bytes, 9_999_999)).deps);
    expect(response).toEqual({
      path: 'x.bin',
      kind: 'binary',
      size: 9_999_999,
      truncated: false,
      language: 'text',
    });
  });

  it('NUL at byte 8193 (just past the window) is text: the window is the definition', async () => {
    const bytes = Buffer.alloc(FILE_VIEWER_BINARY_PROBE_BYTES + 10, 0x61);
    bytes[FILE_VIEWER_BINARY_PROBE_BYTES] = 0; // byte #8193
    const response = await readFileContent(ROOT, 'x.txt', 'alice', harness(file(bytes, bytes.length)).deps);
    expect(response.kind).toBe('text');
    expect(response.content).toBeDefined();
  });

  it('a NUL at the very first byte is binary', async () => {
    const response = await readFileContent(ROOT, 'x.bin', 'alice', harness(file(Buffer.from([0, 1, 2]))).deps);
    expect(response.kind).toBe('binary');
    expect(response.content).toBeUndefined();
  });

  it('decodes UTF-8 with replacement characters and keeps multi-byte text intact', async () => {
    const mixed = await readFileContent(
      ROOT,
      'a.txt',
      'alice',
      harness(file(Buffer.concat([Buffer.from('日本語 '), Buffer.from([0xff]), Buffer.from(' ok')]))).deps,
    );
    expect(mixed.content).toBe('日本語 � ok');
    expect(mixed.truncated).toBe(false);
  });

  it('a read that cut a multi-byte sequence in half decodes with a replacement and says truncated', async () => {
    const cut = Buffer.from('日本語').subarray(0, 4); // 日 + the first byte of 本
    const response = await readFileContent(ROOT, 'a.txt', 'alice', harness(file(cut, CAP + 50)).deps);
    expect(response.content).toBe('日�');
    expect(response.truncated).toBe(true);
  });

  it('language comes from the path (shared map), text when unknown, and the path is echoed as given', async () => {
    const md = await readFileContent(ROOT, 'docs/README.md', 'alice', harness(file(Buffer.from('#'))).deps);
    expect(md.language).toBe('markdown');
    expect(md.path).toBe('docs/README.md');
    const unknown = await readFileContent(ROOT, 'Makefile', 'alice', harness(file(Buffer.from('all:'))).deps);
    expect(unknown.language).toBe('text');
  });
});

describe('mode matrix: no OS user (single-user mode, or the spawn user is the server user)', () => {
  it('never asks the runner for anything: a missing working directory is answered in-process', async () => {
    const { calls, runAsUser } = fakeRunner([]);
    const missing = '/definitely/not/a/real/working/dir-for-the-viewer-test';
    await expect(listDirectory(missing, '', null, { runAsUser })).rejects.toThrow(new NotFoundError('Working directory'));
    await expect(readFileContent(missing, 'a.txt', null, { runAsUser })).rejects.toThrow(
      new NotFoundError('Working directory'),
    );
    await expect(listDirectory(missing, '', '', { runAsUser })).rejects.toThrow(new NotFoundError('Working directory'));
    expect(calls.length).toBe(0);
  });
});
