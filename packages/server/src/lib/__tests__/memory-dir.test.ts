/**
 * Real-filesystem tests for the memory layer's directory creation +
 * verification (epic #1636 Phase 2). Uses real temp dirs under
 * `os.tmpdir()`, cleaned in `afterEach` — this module's whole job is
 * verifying real `mkdir`/`lstat` behavior, so a memfs mock would defeat the
 * point (same rationale as `workers-upload-dir-real-fs.test.ts`).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, rm, symlink, writeFile, lstat, chmod, readdir } from 'fs/promises';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  resolveMemoryDirContract,
  ensureMemoryDir,
  resolveMemoryDirPath,
  prepareMemoryDir,
  MemoryDirVerificationError,
  type MemoryDirContract,
} from '../memory-dir.js';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import { computeQuickCwdSlug } from '../session-data-path.js';
import { buildInternalWorktreeSession } from '../../__tests__/utils/build-test-data.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';

const IS_ROOT = typeof process.geteuid === 'function' && process.geteuid() === 0;

const tempDirs: string[] = [];

function freshTempDir(label: string): string {
  const dir = join(tmpdir(), `memory-dir-test-${label}-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

/**
 * Create and return a fresh, real trusted ROOT directory for a test. The
 * session base lives under it as `<root>/_quick` (`baseUnder`), the same
 * shape production walks from `configDir`; `ensureMemoryDir` is handed
 * `(base, dirname(base))` everywhere below. The root is created here (the
 * walker never creates its root); whether the base is created is each
 * test's own decision.
 */
async function freshTrustedRoot(label: string): Promise<string> {
  const root = freshTempDir(label);
  await mkdir(root, { recursive: true });
  return root;
}

function baseUnder(root: string): string {
  return join(root, '_quick');
}

/** Create and return a fresh, real trusted-base directory (`<root>/_quick`) for a test. */
async function freshTrustedBase(label: string): Promise<string> {
  const base = baseUnder(await freshTrustedRoot(label));
  await mkdir(base);
  return base;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('resolveMemoryDirContract', () => {
  it('returns the single-user 0700 contract when AUTH_MODE is not multi-user', () => {
    const prev = process.env.AUTH_MODE;
    delete process.env.AUTH_MODE;
    try {
      const contract = resolveMemoryDirContract();
      expect(contract.mode).toBe(0o700);
      expect(contract.expectedGid).toBeNull();
    } finally {
      if (prev !== undefined) process.env.AUTH_MODE = prev;
    }
  });

  it('returns the multi-user 2775 contract when AUTH_MODE=multi-user', () => {
    const prev = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'multi-user';
    try {
      const contract = resolveMemoryDirContract();
      expect(contract.mode).toBe(0o2775);
      expect(contract.expectedGid).toBe(process.getgid!());
    } finally {
      if (prev !== undefined) process.env.AUTH_MODE = prev;
      else delete process.env.AUTH_MODE;
    }
  });
});

describe('ensureMemoryDir — single-user contract', () => {
  it('creates the directory with mode exactly 0o700', async () => {
    const base = await freshTrustedBase('single-create');
    const dir = join(base, 'memory', 'def-1');
    await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o700);
  });

  it('is idempotent on a second call (still 0700, no throw)', async () => {
    const base = await freshTrustedBase('single-idempotent');
    const dir = join(base, 'memory', 'def-1');
    await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.mode & 0o7777).toBe(0o700);
  });

  it('creates nested parent segments (memory/<def>) under a fresh base, every segment 0700', async () => {
    const base = await freshTrustedBase('single-nested');
    const dir = join(base, 'memory', 'def-nested');
    await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    const st = await lstat(dir);
    expect(st.isDirectory()).toBe(true);
    const memorySt = await lstat(join(base, 'memory'));
    expect(memorySt.mode & 0o7777).toBe(0o700);
  });

  // Removing the symlink check in ensureMemoryDir fails this pin -- measured
  // below. NOTE: the temp-dir label deliberately avoids the substring
  // "symlink" (used "single-link" instead) -- an earlier draft of this test
  // used a label containing "symlink", which made the rejected path itself
  // (embedded in the thrown message) satisfy a `.toMatch(/symlink/)`
  // assertion regardless of which check inside `ensureMemoryDir` actually
  // fired. The assertion below matches the production message's specific
  // "is a symlink" phrase for the same reason.
  it('rejects a pre-created symlink at the leaf path', async () => {
    const base = await freshTrustedBase('single-link');
    const targetDir = join(base, 'target');
    await mkdir(targetDir, { recursive: true });
    const linkPath = join(base, 'memory-link');
    await symlink(targetDir, linkPath);
    let caught: unknown;
    try {
      await ensureMemoryDir(linkPath, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/is a symlink/);
  });

  it('rejects a pre-created regular file at the path', async () => {
    const base = await freshTrustedBase('single-file');
    const filePath = join(base, 'not-a-dir');
    await writeFile(filePath, 'hello');
    await expect(ensureMemoryDir(filePath, base, dirname(base), { mode: 0o700, expectedGid: null })).rejects.toThrow(
      MemoryDirVerificationError,
    );
  });

  // Reach measured: disabling the mode-exactness `if` in ensureMemoryDir
  // (replacing its condition with `false`) fails this pin AND the
  // multi-user 2755-rejection pin below -- both measured.
  it('rejects a pre-created LEAF directory whose mode is 0o755 (mode-exactness pin)', async () => {
    const base = await freshTrustedBase('single-wrong-mode');
    const dir = join(base, 'memory', 'def-1');
    // The intermediate `memory` segment must itself be a VALID 0700
    // directory here -- this test is about the LEAF's mode, not the
    // intermediate's (that case is covered separately below).
    await mkdir(join(base, 'memory'), { mode: 0o700 });
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    const message = (caught as Error).message;
    expect(message).toContain('755');
    expect(message).toContain('700');
  });

  // Architect-ruled fix for CodeRabbit MAJOR (#1691): the original
  // single-`lstat`-on-the-leaf shape trusted `mkdir(dir, { recursive: true
  // })`'s intermediate symlink traversal, so a group member could
  // pre-plant a symlink at `<base>/memory` (a `2775` directory anyone in
  // the group can create) pointing anywhere, and the leaf created inside
  // it would pass every check.
  //
  // POLARITY, measured: temporarily reverted `ensureMemoryDir`'s per-segment
  // loop to the old single `mkdir(dir, { recursive: true }) + lstat(dir)`
  // shape (edited memory-dir.ts, ran this test alone, restored by
  // re-editing -- never via `git checkout`). Under that old shape this test
  // did NOT throw at all: `mkdir` silently followed the `<base>/memory`
  // symlink and created `<base>/memory/def-1` for real inside
  // `bogusTarget`, and the leaf-only `lstat` on `<base>/memory/def-1`
  // reported an ordinary, correctly-owned `0700` directory -- exactly the
  // silent-redirect defect this fix closes.
  it('rejects a pre-planted symlink at an ANCESTOR segment (<base>/memory)', async () => {
    const base = await freshTrustedBase('ancestor-link');
    const bogusTarget = join(base, 'bogus-target');
    await mkdir(bogusTarget, { recursive: true });
    const memoryPath = join(base, 'memory');
    await symlink(bogusTarget, memoryPath);

    const dir = join(base, 'memory', 'def-1');
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/symlink/);
    expect((caught as Error).message).toContain(memoryPath);

    // Rejection must happen BEFORE any write through the link: the symlink
    // itself is still a symlink, and its target gained NO entry. ABSENCE
    // pin (CodeRabbit, 9f3a9a5b): the earlier `isDirectory()` check on the
    // target let an implementation that writes through the link and throws
    // afterwards pass. Polarity measured: prepending
    // `mkdir(dir, { recursive: true, mode })` to the walk (write-through,
    // then verify) fails this assertion and the quick-shape one below, and
    // nothing else in this file distinguishes that implementation.
    expect((await lstat(memoryPath)).isSymbolicLink()).toBe(true);
    expect(await readdir(bogusTarget)).toEqual([]);
  });

  // Quick-session shape: the symlinked segment sits one level ABOVE the
  // leaf (`<base>/memory/<defId>`), with the cwd-slug leaf still to be
  // created below it.
  //
  // POLARITY, measured: same revert as above -- under the old shape this
  // test did NOT throw; `mkdir(dir, { recursive: true })` followed the
  // `<base>/memory/def-1` symlink and created the cwd-slug leaf for real
  // inside `bogusTarget`, and the leaf-only `lstat` reported a correctly
  // owned `0700` directory.
  it('quick shape: rejects a pre-planted symlink at <base>/memory/<defId>, with a cwd-slug leaf below it', async () => {
    const base = await freshTrustedBase('quick-ancestor-link');
    const bogusTarget = join(base, 'bogus-target');
    await mkdir(bogusTarget, { recursive: true });
    // The intermediate `memory` segment must itself be a VALID 0700
    // directory here -- only `def-1` below it is the pre-planted symlink
    // under test.
    await mkdir(join(base, 'memory'), { mode: 0o700 });
    const defPath = join(base, 'memory', 'def-1');
    await symlink(bogusTarget, defPath);

    const dir = join(base, 'memory', 'def-1', 'some-cwd-slug-abc123');
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/symlink/);
    expect((caught as Error).message).toContain(defPath);
    // No write through the link: the target gained no cwd-slug entry.
    expect((await lstat(defPath)).isSymbolicLink()).toBe(true);
    expect(await readdir(bogusTarget)).toEqual([]);
  });

  // POLARITY, measured: same revert. Under the old shape, `trustedBase`
  // did not exist as a concept at all -- there was no base check, so a
  // symlinked base was never even examined; `mkdir(dir, { recursive: true
  // })` walked straight through it and created the leaf for real inside
  // whatever the base symlink pointed at, passing the (leaf-only) check.
  //
  // Since the trusted-root walker took over base creation, the base is one
  // more segment of the ancestor walk from `parent` (the trusted root): the
  // non-recursive `mkdir` hits EEXIST on the existing symlink and the
  // segment's `lstat`/`isSymbolicLink()` check rejects it, naming the base.
  it('rejects when the trusted base itself is a symlink, naming the base', async () => {
    const parent = await freshTrustedRoot('base-is-link-parent');
    const realBase = join(parent, 'real-base');
    await mkdir(realBase, { recursive: true });
    const linkedBase = join(parent, 'linked-base');
    await symlink(realBase, linkedBase);

    const dir = join(linkedBase, 'memory', 'def-1');
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, linkedBase, parent, { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/symlink/);
    expect((caught as Error).message).toContain(linkedBase);
  });

  // POLARITY: the old shape did not check intermediate segments at all, so
  // it did not reject this case -- but it also did not silently redirect
  // anything (no symlink is involved here, only a wrong-mode plain
  // directory). Measured: `mkdir(dir, { recursive: true, mode: 0o700 })`
  // is a no-op on the ALREADY-EXISTING `<base>/memory` (mode stays 0755,
  // silently wrong forever), then creates the leaf `def-1` fresh at 0700,
  // and the leaf-only `lstat` passes because it only ever looked at the
  // leaf. So the old shape's outcome for this case was NOT "wrongly
  // throws" or "wrongly passes an attacker in" -- it silently leaves a
  // permission-drifted intermediate directory in place forever, with no
  // signal at any layer. The new per-segment verification catches this
  // the moment the drifted segment is walked, before ever reaching the
  // leaf.
  it('rejects when a pre-existing INTERMEDIATE segment (<base>/memory) has mode 0o755', async () => {
    const base = await freshTrustedBase('intermediate-wrong-mode');
    const memoryPath = join(base, 'memory');
    await mkdir(memoryPath, { mode: 0o755 });
    await chmod(memoryPath, 0o755);

    const dir = join(memoryPath, 'def-1');
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    const message = (caught as Error).message;
    expect(message).toContain('755');
    expect(message).toContain('700');
    expect(message).toContain(memoryPath);

    // The leaf must never have been created -- the walk must reject at
    // `memory` BEFORE descending into `def-1`.
    await expect(lstat(dir)).rejects.toThrow();
  });

  // ADOPTION PIN for the trusted-root walker at the base-creation site
  // (docs/design/session-data-path.md section 2): `<root>/_quick` is
  // pre-planted as a symlink to `<root>/elsewhere` BEFORE the call. The old
  // shape created the base with `mkdir(trustedBase, { recursive: true })`
  // and then `lstat`-checked it, so this case was already rejected -- what
  // the walker adds is that the rejection now happens INSIDE the ancestor
  // walk, before any leaf segment is touched. Measured: replacing the
  // ancestor `ensureTrustedDirChain(trustedRoot, trustedBase, ...)` call in
  // `ensureMemoryDir` with a bare `mkdir(trustedBase, { recursive: true })`
  // (no base lstat) fails this pin -- the leaf walk then starts at the
  // symlinked base, `mkdir` follows the link, and `memory/def-1` lands
  // inside `elsewhere` (the readdir assertion is what catches that).
  it('adoption pin: rejects a pre-planted symlink at <root>/_quick and writes nothing through it', async () => {
    const root = await freshTrustedRoot('adoption-link');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const base = baseUnder(root);
    await symlink(elsewhere, base);

    const dir = join(base, 'memory', 'def-1');
    let caught: unknown;
    try {
      await ensureMemoryDir(dir, base, root, { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toMatch(/is a symlink/);
    expect((caught as Error).message).toContain(base);
    expect((await lstat(base)).isSymbolicLink()).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('boundary: a dir outside trustedBase is rejected as "escapes the trusted base"', async () => {
    const base = await freshTrustedBase('escape-base');
    const sibling = freshTempDir('escape-sibling');
    await mkdir(sibling, { recursive: true });

    let caught: unknown;
    try {
      await ensureMemoryDir(sibling, base, dirname(base), { mode: 0o700, expectedGid: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryDirVerificationError);
    expect((caught as Error).message).toContain('escapes');
  });

  // Production gap (found after the ancestor-symlink fix landed):
  // `runActivation` calls `ensureMemoryDirFn` BEFORE `resetWorkerOutput`,
  // and nothing in `createSession` creates `<configDir>/_quick` or
  // `<configDir>/repositories/<slug>` -- they are created lazily by
  // whichever of outputs/messages/memos writes first. A brand-new
  // session's first activation (no message sent yet) would otherwise hit
  // this function's own base `lstat` before any sibling writer ever runs
  // and fail with a raw ENOENT. `trustedBase` here is deliberately NEVER
  // created by the test -- `freshTempDir` only allocates a path.
  it('creates the trusted base itself when absent, then proceeds through the walk (leaf verified 0700)', async () => {
    const root = await freshTrustedRoot('base-absent');
    const base = baseUnder(root);
    // No mkdir(base) here -- this is the point of the test. Only the root
    // exists, as it does in production (the setup script creates it).
    const dir = join(base, 'memory', 'def-1');
    await ensureMemoryDir(dir, base, root, { mode: 0o700, expectedGid: null });

    const baseSt = await lstat(base);
    expect(baseSt.isSymbolicLink()).toBe(false);
    expect(baseSt.isDirectory()).toBe(true);

    const leafSt = await lstat(dir);
    expect(leafSt.isDirectory()).toBe(true);
    expect(leafSt.mode & 0o7777).toBe(0o700);
  });

  it('positive: creates <base>/memory/<defId>/<slug> fresh, every segment mode exactly 0700', async () => {
    const base = await freshTrustedBase('positive-fresh');
    const dir = join(base, 'memory', 'def-1', 'cwd-slug-abc');
    await ensureMemoryDir(dir, base, dirname(base), { mode: 0o700, expectedGid: null });

    for (const segmentPath of [join(base, 'memory'), join(base, 'memory', 'def-1'), dir]) {
      const st = await lstat(segmentPath);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o7777).toBe(0o700);
    }
  });
});

describe('ensureMemoryDir — multi-user contract (real fs, Linux only)', () => {
  it('creates 2775/expected-gid under umask 0002, and rejects 2755 under umask 0022 (mode-exactness pin)', async () => {
    if (process.platform !== 'linux' || typeof process.getgid !== 'function') {
      console.warn('Skipping multi-user setgid test: not Linux or no process.getgid');
      return;
    }
    if (IS_ROOT) {
      console.warn('Skipping multi-user setgid test: running as root (permission checks bypassed)');
      return;
    }
    // This case runs for real in packages/server's second `bun test`
    // invocation (Issue #1699), where `fs/promises` is NOT swapped for
    // memfs (mock-fs-helper.ts never loads there), so `chmod(1)` on this
    // directory and the kernel's setgid inheritance are observed for real.
    await assertRealFs('multi-user setgid inheritance (memory-dir)');
    const base = await freshTrustedBase('multi-user');
    const chmodProc = Bun.spawn(['chmod', '2775', base], { stdout: 'pipe', stderr: 'pipe' });
    const chmodExit = await chmodProc.exited;
    if (chmodExit !== 0) {
      console.warn('Skipping multi-user setgid test: chmod 2775 failed on this filesystem');
      return;
    }
    const parentSt = await lstat(base);
    if ((parentSt.mode & 0o2000) === 0) {
      console.warn('Skipping multi-user setgid test: filesystem did not apply setgid bit');
      return;
    }

    const contract: MemoryDirContract = { mode: 0o2775, expectedGid: process.getgid() };
    const prevUmask = process.umask(0o002);
    try {
      const dir = join(base, 'memory', 'def-1');
      await ensureMemoryDir(dir, base, dirname(base), contract);
      const st = await lstat(dir);
      expect(st.mode & 0o7777).toBe(0o2775);
      expect(st.gid).toBe(process.getgid());
    } finally {
      process.umask(prevUmask);
    }

    // Negative: under umask 0022, mkdir-with-no-mode-arg inherits 2755
    // (world-r-x stripped of group-write), which must FAIL the exactness
    // check against the 2775 contract.
    const prevUmask2 = process.umask(0o022);
    try {
      const dir2 = join(base, 'memory', 'def-2');
      let caught: unknown;
      try {
        await ensureMemoryDir(dir2, base, dirname(base), contract);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MemoryDirVerificationError);
      const message = (caught as Error).message;
      expect(message).toContain('2755');
      expect(message).toContain('2775');
    } finally {
      process.umask(prevUmask2);
    }
  });
});

describe('resolveMemoryDirPath', () => {
  it('worktree session -> <base>/memory/<def>', async () => {
    const resolver = new SessionDataPathResolver('/test/config/repositories/myorg/myrepo', '/test/config');
    const dir = await resolveMemoryDirPath({
      session: { type: 'worktree', locationPath: '/test/worktree' },
      definitionId: 'def-1',
      resolver,
    });
    expect(dir).toBe('/test/config/repositories/myorg/myrepo/memory/def-1');
  });

  it('quick session with a real existing cwd -> <base>/memory/<def>/<slug-of-realpath>', async () => {
    const base = freshTempDir('quick-real-cwd');
    await mkdir(base, { recursive: true });
    const resolver = new SessionDataPathResolver('/test/config/_quick', '/test/config');
    const dir = await resolveMemoryDirPath({
      session: { type: 'quick', locationPath: base },
      definitionId: 'def-1',
      resolver,
    });
    const expectedSlug = computeQuickCwdSlug(base);
    expect(dir).toBe(`/test/config/_quick/memory/def-1/${expectedSlug}`);
  });

  // Reach measured: removing the try/catch fallback in resolveMemoryDirPath
  // (calling `realpath` unconditionally) fails this pin with an unhandled
  // ENOENT -- measured.
  it('quick session with a nonexistent cwd falls back to computeQuickCwdSlug(cwd) directly', async () => {
    const resolver = new SessionDataPathResolver('/test/config/_quick', '/test/config');
    const dir = await resolveMemoryDirPath({
      session: { type: 'quick', locationPath: '/test/quick' },
      definitionId: 'def-1',
      resolver,
    });
    const expectedSlug = computeQuickCwdSlug('/test/quick');
    expect(dir).toBe(`/test/config/_quick/memory/def-1/${expectedSlug}`);
  });
});

describe('prepareMemoryDir', () => {
  it('resolves, creates, and returns the memory dir for a worktree session', async () => {
    const base = await freshTrustedBase('prepare-worktree');
    const resolver = new SessionDataPathResolver(base, dirname(base));
    const definition: EmbeddedAgentDefinition = {
      id: 'def-1',
      name: 'Local model',
      engine: 'openai-api',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      isBuiltIn: false,
      createdBy: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const dir = await prepareMemoryDir({
      session: buildInternalWorktreeSession([], { locationPath: '/test/worktree' }),
      definition,
      resolver,
    });
    expect(dir).toBe(join(base, 'memory', 'def-1'));
    const st = await lstat(dir!);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o7777).toBe(0o700);
  });
});
