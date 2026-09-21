/**
 * Real-filesystem tests for the trusted-root walker (`ensureTrustedDirChain`,
 * docs/design/session-data-path.md section 2). Uses real temp dirs under
 * `os.tmpdir()`, cleaned in `afterEach` -- the module's whole job is real
 * `mkdir` / `lstat` behaviour against pre-planted symlinks, so a memfs mock
 * would defeat the point (same rationale as memory-dir.test.ts). Every case
 * creates its own root INSIDE the temp dir (the walker never creates its
 * root), so the file also runs correctly when a sibling test file has
 * swapped `fs/promises` for memfs process-wide.
 *
 * Two load-order facts, both measured (2026-09-17):
 *   - The walker's default deps resolve `fs/promises` at CALL time through
 *     the namespace import. A first draft captured the function references
 *     at module evaluation; when this file loaded before a memfs-mocking
 *     sibling, the walker kept hitting the real disk and 71 memfs-backed
 *     writer tests failed with `trusted root is not accessible` (0 in the
 *     reverse order). Both orders are green now.
 *   - The symlinked-root case below asserts real fs (via `assertRealFs`),
 *     because memfs answers `mkdir` under a symlinked directory with
 *     ENOTDIR where a kernel follows the link. It runs for real only in
 *     packages/server's second `bun test` invocation (Issue #1699), where
 *     no memfs-mocking sibling ever shares the process. Its mutation was
 *     measured with this file run alone.
 *
 * Mutation reach, measured by editing trusted-dir.ts and running this file
 * alone (restored by re-editing, never via `git checkout`); each case's own
 * comment records which mutation it catches.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, rm, symlink, writeFile, lstat, stat, chmod, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import {
  ensureTrustedDirChain,
  resolveAncestorContract,
  TrustedDirVerificationError,
  type TrustedDirDeps,
  type TrustedDirStats,
  type TrustedSegmentContract,
} from '../trusted-dir.js';

const tempDirs: string[] = [];

/** Allocate (not create) a fresh temp path. */
function freshTempPath(label: string): string {
  const dir = join(tmpdir(), `trusted-dir-test-${label}-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

/** Create and return a fresh, real trusted root. */
async function freshRoot(label: string): Promise<string> {
  const root = freshTempPath(label);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** The ancestor contract with the uid check kept and everything else off -- what production passes for `configDir -> base`. */
const ANCESTOR = resolveAncestorContract();

async function rejects(promise: Promise<unknown>): Promise<TrustedDirVerificationError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TrustedDirVerificationError);
  return caught as TrustedDirVerificationError;
}

describe('resolveAncestorContract', () => {
  // Reach measured: returning `{ expectedGid: process.getgid() }` or a
  // non-null `mode` fails this pin. It is the R3 decision in one object --
  // ancestors assert owner uid ONLY.
  it('asserts owner uid only: gid and mode are null, mkdirMode is omitted', () => {
    const contract = resolveAncestorContract();
    expect(contract.expectedUid).toBe(process.geteuid!());
    expect(contract.expectedGid).toBeNull();
    expect(contract.mode).toBeNull();
    expect(contract.mkdirMode).toBeUndefined();
  });
});

describe('ensureTrustedDirChain -- creation', () => {
  // Reach measured. Making the per-segment `mkdir` recursive
  // (`{ recursive: true }` on each segment) passes ALL 18 cases in this file:
  // inside the walker the flag is inert, because every segment is still
  // `lstat`-verified before the walk descends -- what forbids the shape at
  // the CALL SITES (where it replaces the walk, not one segment of it) is
  // trusted-dir-adoption.test.ts's grep pin. Dropping the `EEXIST` tolerance
  // fails 6 cases: this one (second call), the three pre-planted-symlink
  // cases, the regular-file case, and the R3 pin -- every case with a
  // pre-existing segment.
  it('creates a 3-segment chain fresh, and a second call is idempotent', async () => {
    const root = await freshRoot('fresh-chain');
    const target = join(root, 'repositories', 'org', 'repo');
    await ensureTrustedDirChain(root, target, ANCESTOR);
    for (const p of [join(root, 'repositories'), join(root, 'repositories', 'org'), target]) {
      const st = await lstat(p);
      expect(st.isDirectory()).toBe(true);
      expect(st.isSymbolicLink()).toBe(false);
    }
    await ensureTrustedDirChain(root, target, ANCESTOR);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it('creates a single-segment target directly under the root', async () => {
    const root = await freshRoot('single-segment');
    const target = join(root, '_quick');
    await ensureTrustedDirChain(root, target, ANCESTOR);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  // Reach measured: ignoring `contract.mkdirMode` (always calling `mkdir`
  // with no options) fails this pin -- the leaf comes out umask-derived
  // (0755 under the default umask), not 0700.
  it('passes mkdirMode to mkdir when set (single-user memory leaf shape)', async () => {
    const root = await freshRoot('mkdir-mode');
    const target = join(root, 'memory', 'def-1');
    await ensureTrustedDirChain(root, target, { expectedUid: process.geteuid!(), expectedGid: null, mode: 0o700, mkdirMode: 0o700 });
    expect((await lstat(target)).mode & 0o7777).toBe(0o700);
    expect((await lstat(join(root, 'memory'))).mode & 0o7777).toBe(0o700);
  });
});

describe('ensureTrustedDirChain -- root', () => {
  // Reach measured: deleting the whole `stat(root)` guard (walking straight
  // into the segment loop) fails this pin and the regular-file pin below --
  // the non-recursive `mkdir` of the first segment throws a raw ENOENT /
  // ENOTDIR instead of the verification error.
  it('throws when the root is missing, and never creates it', async () => {
    const root = freshTempPath('root-missing');
    const err = await rejects(ensureTrustedDirChain(root, join(root, '_quick'), ANCESTOR));
    expect(err.message).toContain('trusted root');
    expect(err.message).toContain(root);
    await expect(stat(root)).rejects.toThrow();
  });

  it('throws when the root is a regular file', async () => {
    const root = freshTempPath('root-file');
    await writeFile(root, 'not a dir');
    const err = await rejects(ensureTrustedDirChain(root, join(root, '_quick'), ANCESTOR));
    expect(err.message).toContain('not a directory');
    expect(err.message).toContain(root);
  });

  // The root is trusted by definition: a single-user AGENT_CONSOLE_HOME may
  // legitimately be a symlink. Reach measured: using `lstat` instead of
  // `stat` for the root (rejecting a symlinked root) fails this pin.
  it('accepts a root that is itself a symlink to a directory and creates the chain under it', async () => {
    // memfs (process-globally swapped in for `fs/promises` once any sibling
    // test file imports mock-fs-helper.ts) answers `mkdir` of a child under
    // a SYMLINKED directory with ENOTDIR instead of following the link the
    // way a real kernel does, so this real-fs-only case runs for real only
    // in packages/server's second `bun test` invocation (Issue #1699),
    // where no memfs-mocking sibling ever loads in the same process.
    await assertRealFs('symlinked-root case (trusted-dir)');
    const parent = await freshRoot('root-link-parent');
    const realRoot = join(parent, 'real-root');
    await mkdir(realRoot);
    const linkedRoot = join(parent, 'linked-root');
    await symlink(realRoot, linkedRoot);
    const target = join(linkedRoot, '_quick', 'outputs');
    await ensureTrustedDirChain(linkedRoot, target, ANCESTOR);
    expect((await lstat(join(realRoot, '_quick', 'outputs'))).isDirectory()).toBe(true);
  });
});

describe('ensureTrustedDirChain -- escape boundary', () => {
  // Reach measured: dropping the `rel === ''` arm of the escape check fails
  // the target==root pin (the walk then runs with zero segments and returns
  // silently); dropping the `..` arms fails the outside-root pin (the walk
  // creates `../sibling` for real).
  it('rejects target == root as "escapes"', async () => {
    const root = await freshRoot('escape-self');
    const err = await rejects(ensureTrustedDirChain(root, root, ANCESTOR));
    expect(err.message).toContain('escapes');
  });

  it('rejects a target outside the root as "escapes", and creates nothing', async () => {
    const root = await freshRoot('escape-outside');
    const sibling = join(tmpdir(), `trusted-dir-test-escape-sibling-${randomUUID()}`);
    tempDirs.push(sibling);
    const err = await rejects(ensureTrustedDirChain(root, sibling, ANCESTOR));
    expect(err.message).toContain('escapes');
    expect(err.message).toContain(sibling);
    await expect(lstat(sibling)).rejects.toThrow();
  });
});

describe('ensureTrustedDirChain -- pre-planted symlinks (the defect this walker closes)', () => {
  // POLARITY, measured: replacing the per-segment loop with a single
  // `mkdir(target, { recursive: true })` (the shape every session-data
  // writer used before this walker) makes all three cases below NOT throw:
  // `mkdir` follows the planted link and creates the remaining segments
  // inside `elsewhere`, so `readdir(elsewhere)` is non-empty -- that
  // readdir assertion is the "nothing written through the link" pin, and
  // it is what distinguishes "rejected before any write" from "rejected
  // after writing through". That mutation fails 9 of 18 in this file (these
  // three, the regular-file case, the three deps-seam rejections, the R3
  // pin, and the mkdirMode pin). Also measured: `lstat` -> `stat` in the
  // segment check (following the link) passes the symlink through as a
  // directory and fails 6 (these three plus the three deps-seam
  // rejections, whose override is keyed on the `lstat` seam).
  it('rejects a symlink at the FIRST segment (<root>/_quick), naming it, with the link target left empty', async () => {
    const root = await freshRoot('first-link');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const planted = join(root, '_quick');
    await symlink(elsewhere, planted);
    const target = join(planted, 'outputs', 'session-1');
    const err = await rejects(ensureTrustedDirChain(root, target, ANCESTOR));
    expect(err.message).toContain('is a symlink');
    expect(err.message).toContain(planted);
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('rejects a symlink at a MIDDLE segment (<root>/repositories/<slug>), naming it, with the link target left empty', async () => {
    const root = await freshRoot('middle-link');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(root, 'repositories'));
    const planted = join(root, 'repositories', 'org-repo');
    await symlink(elsewhere, planted);
    const target = join(planted, 'outputs', 'session-1');
    const err = await rejects(ensureTrustedDirChain(root, target, ANCESTOR));
    expect(err.message).toContain('is a symlink');
    expect(err.message).toContain(planted);
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
    // Rejected at `org-repo`, before descending: nothing below it exists.
    await expect(lstat(join(elsewhere, 'outputs'))).rejects.toThrow();
  });

  it('rejects a symlink at the LEAF, naming it, with the link target left empty', async () => {
    const root = await freshRoot('leaf-link');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(root, '_quick'));
    const planted = join(root, '_quick', 'memos');
    await symlink(elsewhere, planted);
    const err = await rejects(ensureTrustedDirChain(root, planted, ANCESTOR));
    expect(err.message).toContain('is a symlink');
    expect(err.message).toContain(planted);
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  // Reach measured: dropping the `isDirectory()` check fails this pin --
  // the non-recursive `mkdir` reports EEXIST on the file, which is
  // tolerated, and without the check the walk proceeds to `mkdir` under a
  // file (ENOTDIR, a raw errno instead of the verification error).
  it('rejects a pre-planted regular file at a segment, naming it', async () => {
    const root = await freshRoot('file-segment');
    const planted = join(root, '_quick');
    await writeFile(planted, 'not a directory');
    const err = await rejects(ensureTrustedDirChain(root, join(planted, 'outputs'), ANCESTOR));
    expect(err.message).toContain('not a directory');
    expect(err.message).toContain(planted);
  });
});

/**
 * Build a `deps` whose `lstat` answers with the REAL stats for every path
 * except `overridePath`, where the given fields are substituted. This is
 * the pay-as-you-go seam the AC names for the uid/gid/mode mismatch cases:
 * a different owner cannot be produced without a second OS user, so the
 * Stats-shaped object stands in for it. `mkdir` and `stat` stay real, so the
 * walk still creates and reads real directories.
 */
function depsWithLstatOverride(overridePath: string, fields: Partial<Pick<TrustedDirStats, 'uid' | 'gid' | 'mode'>>): TrustedDirDeps {
  return {
    mkdir: (p, options) => mkdir(p, options),
    stat: (p) => stat(p),
    lstat: async (p) => {
      const st = await lstat(p);
      if (p !== overridePath) return st;
      return {
        isSymbolicLink: () => st.isSymbolicLink(),
        isDirectory: () => st.isDirectory(),
        uid: fields.uid ?? st.uid,
        gid: fields.gid ?? st.gid,
        mode: fields.mode ?? st.mode,
      };
    },
  };
}

describe('ensureTrustedDirChain -- uid / gid / mode contract via the deps.lstat seam', () => {
  // Reach measured: dropping the uid `if` in the walker fails this pin
  // (and only this pin -- which is exactly why the seam exists: no real-fs
  // case in this file can produce a foreign uid).
  it('rejects a segment whose owner uid differs from expectedUid, naming it', async () => {
    const root = await freshRoot('uid-mismatch');
    const first = join(root, '_quick');
    const deps = depsWithLstatOverride(first, { uid: process.geteuid!() + 1 });
    const err = await rejects(ensureTrustedDirChain(root, join(first, 'outputs'), ANCESTOR, deps));
    expect(err.message).toContain('unexpected owner uid');
    expect(err.message).toContain(first);
    // Rejected at `_quick`, before descending.
    await expect(lstat(join(first, 'outputs'))).rejects.toThrow();
  });

  // Reach measured: dropping the gid `if` fails this pin.
  it('rejects a segment whose gid differs from a non-null expectedGid, naming it', async () => {
    const root = await freshRoot('gid-mismatch');
    const first = join(root, 'memory');
    const realGid = process.getgid!();
    const deps = depsWithLstatOverride(first, { gid: realGid + 1 });
    const contract: TrustedSegmentContract = { expectedUid: process.geteuid!(), expectedGid: realGid, mode: null };
    const err = await rejects(ensureTrustedDirChain(root, join(first, 'def-1'), contract, deps));
    expect(err.message).toContain('unexpected group gid');
    expect(err.message).toContain(first);
  });

  // Reach measured: dropping the mode `if` fails this pin and the R3 pin's
  // inline negative half. Comparing the raw `st.mode` instead of
  // `st.mode & 0o7777` does NOT fail this pin (the seam's S_IFDIR|0755
  // mismatches 0o700 either way, and the message still prints the masked
  // value) -- that mutation is caught by the mkdirMode pin above instead,
  // where a real 0o040700 directory stops equalling its own 0o700 contract.
  it('rejects a segment whose mode is not exactly the contract mode, naming it with both values', async () => {
    const root = await freshRoot('mode-mismatch');
    const first = join(root, 'memory');
    // S_IFDIR | 0o755 -- a real directory type with a drifted permission set.
    const deps = depsWithLstatOverride(first, { mode: 0o040755 });
    const contract: TrustedSegmentContract = { expectedUid: process.geteuid!(), expectedGid: null, mode: 0o700 };
    const err = await rejects(ensureTrustedDirChain(root, join(first, 'def-1'), contract, deps));
    expect(err.message).toContain('unexpected mode 755');
    expect(err.message).toContain('expected 700');
    expect(err.message).toContain(first);
  });

  // R3's pin. A service-user-owned ancestor created before the setgid
  // contract (a pre-2775 `repositories/`, or any 0755 directory) MUST be
  // accepted by the ancestor contract, because a pre-planted symlink is
  // caught by `lstat` regardless and a group member's pre-planted real
  // directory is caught by uid -- gid/mode on ancestors would only fail the
  // first deploy with no attack present. Measured: changing the contract
  // below to `{ ...ANCESTOR, mode: 0o755 }` still passes (the dir IS 0755),
  // while `{ ...ANCESTOR, mode: 0o2775 }` -- what asserting the data-root
  // contract on ancestors would look like -- fails it with "unexpected mode
  // 755". The negative half is asserted inline so the pin carries its own
  // polarity.
  it('accepts a pre-existing 0o755 ancestor under the ancestor contract (mode: null, expectedGid: null skip their checks)', async () => {
    const root = await freshRoot('r3-ancestor');
    const repositories = join(root, 'repositories');
    await mkdir(repositories);
    await chmod(repositories, 0o755);
    const target = join(repositories, 'org', 'repo');
    await ensureTrustedDirChain(root, target, ANCESTOR);
    expect((await lstat(target)).isDirectory()).toBe(true);

    // Polarity inline: the SAME tree under a contract that asserts the
    // setgid mode on ancestors is rejected at `repositories`.
    const err = await rejects(ensureTrustedDirChain(root, join(repositories, 'org2'), { ...ANCESTOR, mode: 0o2775 }));
    expect(err.message).toContain('unexpected mode 755');
    expect(err.message).toContain(repositories);
  });

  it('expectedUid: null skips the uid check', async () => {
    const root = await freshRoot('uid-null');
    const first = join(root, '_quick');
    const deps = depsWithLstatOverride(first, { uid: process.geteuid!() + 1 });
    await ensureTrustedDirChain(root, join(first, 'outputs'), { expectedUid: null, expectedGid: null, mode: null }, deps);
    expect((await lstat(join(first, 'outputs'))).isDirectory()).toBe(true);
  });
});
