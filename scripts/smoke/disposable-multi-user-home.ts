/**
 * Shared library for the multi-user embedded-agent smokes (Issue #1713):
 * builds a disposable `AGENT_CONSOLE_HOME` that emulates the production
 * data root's `2775` setgid contract, so a smoke's own home satisfies the
 * memory layer's verification (packages/server/src/lib/memory-dir.ts, epic
 * #1636 Phase 2) instead of failing closed against a plain `mkdir -p` home.
 *
 * Not an entry point -- it has no `main()` and running it directly does
 * nothing, so it is a library by content and exempt from test-trigger.md's
 * smoke registration rule under its "Exceptions to the reachability rule"
 * section (same shape as `probe-sdk-session-harness.ts`).
 *
 * Production satisfies the `2775` contract by construction:
 * `scripts/setup-multiuser-for-ubuntu.sh` step 5 creates the data root with
 * `install -d -o <service-user> -g <group> -m 2775`, and the systemd unit
 * runs with `UMask=0002`, so every segment created under it with NO `mode`
 * argument (see `memory-dir.ts`'s own header) inherits setgid + group-write.
 * A `mkdtemp` directory under `os.tmpdir()` has neither: no setgid bit (so
 * `_quick/` and `memory/` created below it cannot inherit it) and the
 * invoking shell's own umask defaults to `022` (so a fresh segment comes out
 * `755`, not `2775`). `process.umask(0o002)` alone would only yield `0775`
 * -- the home ITSELF must carry `2775` for setgid inheritance to work at all.
 *
 * The memory layer's contract is VERIFICATION, not configuration
 * (`memory-dir.ts`'s own "verification, not configuration" comment) --
 * precisely so a misconfigured production data root fails closed. This
 * helper's job is to build a disposable smoke home that actually satisfies
 * that contract, and to fail loudly (a "cannot run" result, mapped by the
 * caller to exit 2) rather than let a filesystem that refuses setgid (e.g.
 * some tmpfs mounts) produce a silent `755` that only surfaces later as a
 * `MemoryDirVerificationError` deep inside embedded-agent activation.
 */
import { mkdtemp, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MULTI_USER_HOME_MODE = 0o2775;
const MULTI_USER_UMASK = 0o002;

export type CreateDisposableMultiUserHomeResult =
  | { ok: true; path: string; prevUmask: number }
  | { ok: false; reason: string; path: string; prevUmask: number };

/**
 * Creates a fresh `mkdtemp` directory under `os.tmpdir()`, chmods it to
 * `2775` via the `chmod` BINARY -- Bun's `fs.chmod` drops the setgid bit
 * (see `packages/server/src/routes/workers.ts` L55-56's identical note on
 * `ensureUploadDir`) -- sets `process.umask(0o002)` to emulate the
 * production unit's `UMask=0002`, and VERIFIES the result actually carries
 * `2775` and the expected gid before handing it back.
 *
 * `process.umask(0o002)` is always applied, and the PREVIOUS umask is
 * always returned as `prevUmask`, on both the `ok: true` and `ok: false`
 * branches -- the umask change has already happened by the time
 * verification runs, so the caller must restore it (`process.umask(prevUmask)`)
 * in a `finally` regardless of which branch it gets.
 *
 * `ok: false` means the filesystem backing `os.tmpdir()` does not honour
 * the `2775` contract here (e.g. a tmpfs mount that refuses setgid, or a
 * mount option that assigns a fresh directory's group differently than
 * this process's own gid) -- a loud, structured "cannot run" result naming
 * the filesystem, for the caller to map to exit 2, rather than a silent
 * `755` that would only surface much later as a `MemoryDirVerificationError`
 * deep inside embedded-agent activation.
 *
 * @param prefix passed to `mkdtemp` (e.g. `'ac-embedded-smoke-cfg-'`).
 */
export async function createDisposableMultiUserHome(
  prefix: string,
): Promise<CreateDisposableMultiUserHomeResult> {
  const home = await mkdtemp(join(tmpdir(), prefix));

  const chmodProc = Bun.spawn(['chmod', '2775', home], { stdout: 'pipe', stderr: 'pipe' });
  const chmodExit = await chmodProc.exited;

  // The umask change is applied here, unconditionally, BEFORE either
  // verification check below -- both `ok: false` branches still return it
  // so the caller can restore it, since by the time either check can fail
  // the umask has already been changed for the whole process.
  const prevUmask = process.umask(MULTI_USER_UMASK);

  if (chmodExit !== 0) {
    const stderr = await new Response(chmodProc.stderr).text();
    return {
      ok: false,
      reason:
        `chmod 2775 ${home} failed (exit ${chmodExit}): ${stderr.trim()} -- ` +
        `the filesystem backing ${tmpdir()} may not support chmod(1)`,
      path: home,
      prevUmask,
    };
  }

  const st = await lstat(home);
  const actualMode = st.mode & 0o7777;
  if (actualMode !== MULTI_USER_HOME_MODE) {
    return {
      ok: false,
      reason:
        `${home} has mode ${actualMode.toString(8)} after chmod 2775 (expected 2775) -- ` +
        `the filesystem backing ${tmpdir()} refuses the setgid bit, so a multi-user smoke's ` +
        'disposable home cannot emulate the production data-root contract here',
      path: home,
      prevUmask,
    };
  }
  if (typeof process.getgid === 'function' && st.gid !== process.getgid()) {
    return {
      ok: false,
      reason:
        `${home} has gid ${st.gid} (expected ${process.getgid()}, this process's own gid) -- ` +
        `the filesystem backing ${tmpdir()} assigns a fresh directory's group ownership ` +
        'differently than this process expects',
      path: home,
      prevUmask,
    };
  }

  return { ok: true, path: home, prevUmask };
}
