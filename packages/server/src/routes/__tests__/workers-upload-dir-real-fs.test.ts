/**
 * Real-filesystem regression test for the multi-user upload directory's
 * mode/group contract (Issue #830 follow-up).
 *
 * Why this test exists:
 *
 * The original memfs-based multi-user test in `workers.test.ts` passed
 * against memfs's in-memory simulation, whose `mkdir` honours the mode
 * arg literally — including special bits like setgid (0o2000). Bun's
 * own `fs.mkdir({ mode })` and `fs.chmod(dir, mode)` strip the special
 * bits in the JS layer BEFORE the syscall (verified by strace: setgid
 * 0o2000 / setuid 0o4000 / sticky 0o1000 are all dropped). The kernel
 * itself honours setgid when invoked directly (shell
 * `mkdir --mode=2750` → `drwxr-s---`), but Bun's bindings never pass
 * the bit through. The bug PR #831 introduced shipped to a real Ubuntu
 * 24.04 host precisely because the memfs-based test could not exercise
 * Bun's JS-layer mode stripping.
 *
 * Process-isolation complication:
 *
 * `workers.test.ts` (and several other files in this suite) transitively
 * load `mock-fs-helper.ts`, which calls
 * `mock.module('fs/promises', () => memfs.fs.promises)`. `mock.module`
 * is process-global and irreversible in `bun:test` (see
 * `.claude/rules/testing.md` "Module-Level Mocking" anti-pattern). So
 * when this file runs as part of the full suite, ALL `fs/promises`
 * calls — even ones in production code reachable from here — are
 * routed to memfs, NOT real Bun bindings.
 *
 * Strategy:
 *
 *   1. Kernel-level probe (always runs): uses `Bun.spawn` to invoke
 *      shell mkdir / chmod / stat. `Bun.spawn` is not subject to
 *      `mock.module`. Asserts that the Linux kernel + the host
 *      filesystem honour setgid (the precondition for the workaround
 *      to work at all).
 *
 *   2. Bun JS-layer probe (skip when memfs is loaded): asserts that
 *      Bun's own `fs.mkdir({ mode: 0o2750 })` produces 0o750 — i.e.
 *      the bug the workaround targets. Under the full suite
 *      `fs/promises` is memfs-mocked so this probe cannot exercise
 *      the real Bun binding; it is then skipped with a clear note.
 *      If a future Bun release fixes the JS-layer stripping, this
 *      probe (when run alone) fails and prompts a deliberate update
 *      to `workers.ts` so the spawn-chmod step can become an
 *      in-process chmod.
 *
 *   3. End-to-end probes (skip when memfs is loaded): drive
 *      `__TESTING__.ensureUploadDir()` against the real fs and
 *      assert the resulting dir's mode/gid via `stat(1)`. Skipped
 *      under the full suite because `fs/promises` is mocked to
 *      memfs by then; run when this file is invoked alone:
 *
 *        bun test packages/server/src/routes/__tests__/workers-upload-dir-real-fs.test.ts
 */

import { describe, it, expect } from 'bun:test';
import * as os from 'os';
import { join as pathJoin } from 'path';
import { __TESTING__ } from '../workers.js';
import { isMemfsActive } from '../../__tests__/utils/memfs-detection.js';

const SUPPORTS_SETGID_CONTRACT =
  process.platform === 'linux' && typeof process.geteuid === 'function';

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command and return { exitCode, stdout, stderr }.
 * Uses `Bun.spawn`, which is not subject to `mock.module('fs', ...)` —
 * so any operation issued via this helper hits the real kernel /
 * filesystem regardless of memfs hooks installed elsewhere in the
 * test suite.
 */
async function spawnCheck(argv: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe('Upload directory real-fs contract (#830 regression)', () => {
  /**
   * Kernel-level precondition probe — always runs (uses Bun.spawn so
   * unaffected by memfs hooks). Asserts that the Linux kernel + the
   * host filesystem honour setgid at mkdir time AND via chmod. If a
   * future host's filesystem or kernel drops setgid, the workaround
   * cannot succeed; that case surfaces here rather than silently
   * shipping mode 0o750 again.
   */
  it.skipIf(!SUPPORTS_SETGID_CONTRACT)(
    'kernel + host fs honour setgid on mkdir(2) and chmod(1)',
    async () => {
      const mk = await spawnCheck(['mktemp', '-d', '-p', os.tmpdir(), 'ac-kernel-probe.XXXXXX']);
      expect(mk.exitCode).toBe(0);
      const parent = mk.stdout.trim();
      const direct = pathJoin(parent, 'direct');
      const viaChmod = pathJoin(parent, 'viaChmod');

      try {
        // Probe A: shell `mkdir --mode=2750` — the kernel mkdirat(2)
        // syscall, given mode 02750, produces a directory with the
        // setgid bit set. Demonstrates that the kernel and the
        // underlying filesystem support setgid.
        const md = await spawnCheck(['mkdir', '--mode=2750', direct]);
        expect(md.exitCode).toBe(0);
        const stA = await spawnCheck(['stat', '-c', '%a', direct]);
        expect(stA.exitCode).toBe(0);
        expect(stA.stdout.trim()).toBe('2750');

        // Probe B: shell `chmod 2750` after a plain `mkdir`. This is
        // the syscall path the production workaround uses to set the
        // bit after Bun's mkdir drops it.
        const md2 = await spawnCheck(['mkdir', viaChmod]);
        expect(md2.exitCode).toBe(0);
        const cm = await spawnCheck(['chmod', '2750', viaChmod]);
        expect(cm.exitCode).toBe(0);
        const stB = await spawnCheck(['stat', '-c', '%a', viaChmod]);
        expect(stB.exitCode).toBe(0);
        expect(stB.stdout.trim()).toBe('2750');
      } finally {
        await spawnCheck(['rmdir', direct]);
        await spawnCheck(['rmdir', viaChmod]);
        await spawnCheck(['rmdir', parent]);
      }
    },
  );

  /**
   * Bun JS-layer probe — asserts that Bun's `fs.mkdir({ mode: 0o2750 })`
   * drops the setgid bit before issuing the syscall. This is the
   * defect that motivates the production workaround. If a future Bun
   * release fixes it (the strace output then shows
   * `mkdirat(..., 02750)` instead of `mkdirat(..., 0750)`), this
   * assertion fails and prompts replacing the spawn-chmod step in
   * `workers.ts` with a simpler in-process chmod.
   *
   * Skipped under the full suite (fs/promises is mocked to memfs).
   * Run this file alone to exercise.
   */
  it.skipIf(!SUPPORTS_SETGID_CONTRACT)(
    'Bun fs.mkdir strips setgid in the JS layer (this is the bug the route works around)',
    async () => {
      if (await isMemfsActive()) {
        console.log(
          '[skip] memfs is active in this process; fs.mkdir is mocked. Run this file alone (`bun test workers-upload-dir-real-fs.test.ts`) to probe the real Bun binding.',
        );
        return;
      }

      const mk = await spawnCheck(['mktemp', '-d', '-p', os.tmpdir(), 'ac-bun-probe.XXXXXX']);
      expect(mk.exitCode).toBe(0);
      const parent = mk.stdout.trim();
      const target = pathJoin(parent, 'd');

      try {
        const fsp = await import('fs/promises');
        await fsp.mkdir(target, { mode: 0o2750 });
        const st = await spawnCheck(['stat', '-c', '%a', target]);
        expect(st.exitCode).toBe(0);
        // Bun 1.3.10 strips setgid → result is 0o750.
        expect(st.stdout.trim()).toBe('750');

        // Also assert that Bun's fs.chmod does the same.
        await fsp.chmod(target, 0o2750);
        const st2 = await spawnCheck(['stat', '-c', '%a', target]);
        expect(st2.exitCode).toBe(0);
        expect(st2.stdout.trim()).toBe('750');
      } finally {
        await spawnCheck(['rmdir', target]);
        await spawnCheck(['rmdir', parent]);
      }
    },
  );

  /**
   * End-to-end probe: drive the actual `ensureUploadDir()` on the
   * real filesystem under AUTH_MODE=multi-user and assert the
   * resulting directory is mode 2750 with the expected gid.
   *
   * Skipped under the full suite because `fs/promises` is mocked to
   * memfs by an earlier file. Runs when this file is invoked alone.
   */
  it.skipIf(!SUPPORTS_SETGID_CONTRACT)(
    'ensureUploadDir() applies setgid via spawned chmod under AUTH_MODE=multi-user (end-to-end)',
    async () => {
      if (await isMemfsActive()) {
        console.log(
          '[skip] memfs is active in this test process; ensureUploadDir() would land on memfs. Run this file alone to exercise.',
        );
        return;
      }

      const mk = await spawnCheck(['mktemp', '-d', '-p', os.tmpdir(), 'ac-upload-real.XXXXXX']);
      expect(mk.exitCode).toBe(0);
      const tmpParent = mk.stdout.trim();

      const originalAuthMode = process.env.AUTH_MODE;
      const originalTmpdir = process.env.TMPDIR;
      process.env.AUTH_MODE = 'multi-user';
      // The route resolves the upload dir from os.tmpdir(); rerouting
      // TMPDIR gives us a per-test parent dir for clean cleanup.
      process.env.TMPDIR = tmpParent;

      const euid = (process.geteuid as () => number)();
      const expectedUploadDir = pathJoin(tmpParent, `agent-console-uploads-${euid}`);

      try {
        const dir = await __TESTING__.ensureUploadDir();
        expect(dir).toBe(expectedUploadDir);

        // Verify mode + gid via shell `stat` (independent of any
        // fs-level mock that may be active).
        const st = await spawnCheck(['stat', '-c', '%a:%g', expectedUploadDir]);
        expect(st.exitCode).toBe(0);
        const [perm, gid] = st.stdout.trim().split(':');
        expect(perm).toBe('2750');
        expect(Number(gid)).toBe((process.getgid as () => number)());
      } finally {
        await spawnCheck(['rmdir', expectedUploadDir]);
        await spawnCheck(['rmdir', tmpParent]);

        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
        if (originalTmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = originalTmpdir;
        }
      }
    },
  );

  /**
   * Single-user mode (AUTH_MODE=none) must remain mode 0700 with no
   * special bits and no shell-out. Regression guard against the fix
   * accidentally widening the single-user contract.
   */
  it.skipIf(!SUPPORTS_SETGID_CONTRACT)(
    'ensureUploadDir() keeps mode 0700 in single-user mode (end-to-end)',
    async () => {
      if (await isMemfsActive()) {
        console.log(
          '[skip] memfs is active in this test process; run this file alone to exercise.',
        );
        return;
      }

      const mk = await spawnCheck([
        'mktemp',
        '-d',
        '-p',
        os.tmpdir(),
        'ac-upload-single.XXXXXX',
      ]);
      expect(mk.exitCode).toBe(0);
      const tmpParent = mk.stdout.trim();

      const originalAuthMode = process.env.AUTH_MODE;
      const originalTmpdir = process.env.TMPDIR;
      delete process.env.AUTH_MODE;
      process.env.TMPDIR = tmpParent;

      const euid = (process.geteuid as () => number)();
      const expectedUploadDir = pathJoin(tmpParent, `agent-console-uploads-${euid}`);

      try {
        const dir = await __TESTING__.ensureUploadDir();
        expect(dir).toBe(expectedUploadDir);

        const st = await spawnCheck(['stat', '-c', '%a', expectedUploadDir]);
        expect(st.exitCode).toBe(0);
        expect(st.stdout.trim()).toBe('700');
      } finally {
        await spawnCheck(['rmdir', expectedUploadDir]);
        await spawnCheck(['rmdir', tmpParent]);

        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
        if (originalTmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = originalTmpdir;
        }
      }
    },
  );
});
