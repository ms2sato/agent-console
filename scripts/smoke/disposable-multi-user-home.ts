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
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MULTI_USER_HOME_MODE = 0o2775;
const MULTI_USER_UMASK = 0o002;

/**
 * `ok: false` changes NO process state -- verification failing means this
 * function never touches `process.umask()`, so there is no previous mask
 * to hand back and nothing for the caller to restore on this branch.
 */
export type CreateDisposableMultiUserHomeResult =
  | { ok: true; path: string; prevUmask: number }
  | { ok: false; reason: string; path: string };

/**
 * Creates a fresh `mkdtemp` directory under `os.tmpdir()`, chmods it to
 * `2775` via the `chmod` BINARY -- Bun's `fs.chmod` drops the setgid bit
 * (see `packages/server/src/routes/workers.ts` L55-56's identical note on
 * `ensureUploadDir`) -- VERIFIES the result actually carries `2775` and the
 * expected gid, and only THEN sets `process.umask(0o002)` to emulate the
 * production unit's `UMask=0002` before handing it back.
 *
 * `process.umask(0o002)` is called ONLY on the success path, immediately
 * before `return { ok: true, ... }`, with nothing between the call and the
 * return -- verification does not need it (the home's own mode comes from
 * the `chmod` above; the umask only matters for children created later),
 * and calling it any earlier would risk a thrown `lstat` losing track of
 * the previous mask between the call and a caller that never received it.
 * `ok: false` therefore never changes `process.umask()` and carries no
 * `prevUmask` to restore.
 *
 * `ok: false` means the filesystem backing `os.tmpdir()` does not honour
 * the `2775` contract here (e.g. a tmpfs mount that refuses setgid, or a
 * mount option that assigns a fresh directory's group differently than
 * this process's own gid) -- a loud, structured "cannot run" result naming
 * the filesystem, for the caller to map to exit 2, rather than a silent
 * `755` that would only surface much later as a `MemoryDirVerificationError`
 * deep inside embedded-agent activation. The helper removes the mkdtemp'd
 * directory itself before every `ok: false` return (best-effort), so no
 * caller can forget to clean up a home that never became usable; `path` is
 * still included in the result for diagnostics/logging.
 *
 * @param prefix passed to `mkdtemp` (e.g. `'ac-embedded-smoke-cfg-'`).
 */
export async function createDisposableMultiUserHome(
  prefix: string,
): Promise<CreateDisposableMultiUserHomeResult> {
  const home = await mkdtemp(join(tmpdir(), prefix));

  // Best-effort removal of the mkdtemp'd home on any `ok: false` return
  // below -- a directory that never became a valid 2775 contract home has
  // nothing worth keeping, and cleaning it up HERE means no caller can
  // forget to (CodeRabbit MAJOR/MINOR on PR #1715, folded into one fix per
  // the Architect's ruling: the caller-side cleanup this originally relied
  // on required every caller to remember to assign the path before its own
  // ok-check, which is exactly the kind of thing a helper should not ask
  // its callers to get right).
  const removeFailedHome = () => rm(home, { recursive: true, force: true }).catch(() => {});

  // Everything below is wrapped so an UNEXPECTED throw (chmodProc.exited
  // rejecting, lstat throwing on some exotic filesystem, etc. -- distinct
  // from the three EXPECTED failure shapes each already handled by their
  // own `ok: false` return) still removes the mkdtemp'd home before
  // propagating, rather than leaking a directory that no caller's own
  // `ok: false` branch was ever reached to clean up (CodeRabbit MINOR,
  // PR #1715 second review pass).
  try {
    const chmodProc = Bun.spawn(['chmod', '2775', home], { stdout: 'pipe', stderr: 'pipe' });
    const chmodExit = await chmodProc.exited;
    if (chmodExit !== 0) {
      const stderr = await new Response(chmodProc.stderr).text();
      await removeFailedHome();
      return {
        ok: false,
        reason:
          `chmod 2775 ${home} failed (exit ${chmodExit}): ${stderr.trim()} -- ` +
          `the filesystem backing ${tmpdir()} may not support chmod(1)`,
        path: home,
      };
    }

    const st = await lstat(home);
    const actualMode = st.mode & 0o7777;
    if (actualMode !== MULTI_USER_HOME_MODE) {
      await removeFailedHome();
      return {
        ok: false,
        reason:
          `${home} has mode ${actualMode.toString(8)} after chmod 2775 (expected 2775) -- ` +
          `the filesystem backing ${tmpdir()} refuses the setgid bit, so a multi-user smoke's ` +
          'disposable home cannot emulate the production data-root contract here',
        path: home,
      };
    }
    if (typeof process.getgid === 'function' && st.gid !== process.getgid()) {
      await removeFailedHome();
      return {
        ok: false,
        reason:
          `${home} has gid ${st.gid} (expected ${process.getgid()}, this process's own gid) -- ` +
          `the filesystem backing ${tmpdir()} assigns a fresh directory's group ownership ` +
          'differently than this process expects',
        path: home,
      };
    }

    // Only now, right before returning ok:true -- nothing between this
    // call and the return, so this state change and the caller's ability
    // to restore it can never be split by an intervening throw.
    const prevUmask = process.umask(MULTI_USER_UMASK);
    return { ok: true, path: home, prevUmask };
  } catch (err) {
    await removeFailedHome();
    throw err;
  }
}
