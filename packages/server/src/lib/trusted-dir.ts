/**
 * Trusted-root walker for the session-data tree.
 *
 * The memory layer's per-segment loop (see docs/design/embedded-agent-worker.md
 * "Ownership and location" and docs/design/session-data-path.md section 2),
 * generalized to start at `configDir` (the trusted root) instead of a
 * session's own base directory, and adopted by every creator of a
 * session-data directory or its ancestors.
 *
 * **R2 -- verify on every call, no readiness cache.** The cost is a handful
 * of `lstat` calls per write, which the recursive `mkdir` this walker
 * replaces already paid in syscalls.
 *
 * **R3 -- why ancestor segments assert owner uid only, never gid or mode.**
 * A pre-planted symlink is caught by `lstat` regardless of any ownership
 * contract; a pre-planted real directory created by another group member is
 * caught by the uid check; a service-user-owned ancestor created before the
 * setgid (`2775`) contract existed -- a pre-`2775` `repositories/` directory
 * on an already-deployed host -- would fail a gid or mode check on the very
 * first deploy after this walker ships, with no attack present. The leaf
 * contracts (the memory layer's exact mode/gid pair) are unaffected: they
 * are asserted by the caller's own contract, not by `resolveAncestorContract`.
 *
 * **Accepted residue (R7, unchanged from the memory layer's own #1698
 * contract, spec D1).** This defends against a symlink PRE-PLANTED before a
 * given call runs. It does NOT defend against a symlink swapped in between
 * this walker's `lstat` of a segment and a later use of that same path (a
 * TOCTOU race) -- no `O_NOFOLLOW` / `openat`-relative-fd chain is attempted
 * here. A group member racing that narrow window is inside the
 * team-of-trust model the `2775` data-root contract already accepts: any
 * group member may already read, write, or replace files under a
 * server-created directory once it exists. This walker's job is only to
 * stop a pre-planted symlink from silently redirecting the directory the
 * server is about to create or hand to a caller.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('trusted-dir');

export class TrustedDirVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedDirVerificationError';
  }
}

/**
 * Per-segment contract the walker verifies after creating/confirming a
 * segment. Ancestors (R3) use {@link resolveAncestorContract} (uid only);
 * the memory layer's leaf keeps #1698's exact gid/mode contract.
 */
export interface TrustedSegmentContract {
  /** `null` skips the uid check (`process.geteuid` unavailable on this platform). */
  expectedUid: number | null;
  /** `null` skips the gid check. */
  expectedGid: number | null;
  /** Exact `st.mode & 0o7777` required when non-null; `null` skips the check. */
  mode: number | null;
  /** Passed to `mkdir` as `{ mode }` when set; omitted lets umask/setgid inherit. */
  mkdirMode?: number;
}

/** The minimal `Stats` surface the walker reads, so the DI seam can hand in a plain object. */
export interface TrustedDirStats {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  uid: number;
  gid: number;
  mode: number;
}

export interface TrustedDirDeps {
  mkdir: (p: string, options?: { mode: number }) => Promise<unknown>;
  lstat: (p: string) => Promise<TrustedDirStats>;
  stat: (p: string) => Promise<TrustedDirStats>;
}

// Resolve the fs functions at CALL time through the live `fs` module
// namespace object, not as captured references. Test files swap
// `fs/promises` process-globally via `mock.module` (memfs); that swap
// replaces the binding the `fs` namespace import resolves through, so a
// call made through `fs.mkdir(...)` always sees whichever implementation is
// currently installed, regardless of module load order relative to the
// mock. A plain object literal capturing `mkdir`/`lstat`/`stat` at module
// evaluation time would instead freeze whatever was installed (or the real
// disk, if evaluated before any mock) at that moment -- `memory-dir.ts`'s
// named imports were live bindings read at call time; this must be too.
const defaultDeps: TrustedDirDeps = {
  mkdir: (p, options) => fs.mkdir(p, options),
  lstat: (p) => fs.lstat(p),
  stat: (p) => fs.stat(p),
};

/**
 * The ancestor contract every session-data creator uses for segments above
 * its own leaf: verify owner uid only (R3), never gid or mode. Reads
 * `process.geteuid` at call time, never at module load, and never reads
 * `serverConfig`.
 */
export function resolveAncestorContract(): TrustedSegmentContract {
  return {
    expectedUid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    expectedGid: null,
    mode: null,
  };
}

function failAndThrow(detail: Record<string, unknown>, message: string): never {
  logger.error(detail, message);
  throw new TrustedDirVerificationError(message);
}

/**
 * Create (idempotently) and verify every path segment from `root` down to
 * `target`, non-recursively, rejecting a pre-planted symlink or an
 * unexpected owner at any segment (R1). `root` itself is trusted by
 * definition and is NEVER created here -- only verified to exist and be a
 * directory (a root that is itself a symlink to a directory is ACCEPTED;
 * deliberate, since a single-user `AGENT_CONSOLE_HOME` may legitimately be
 * one).
 *
 * @throws {TrustedDirVerificationError} if `root` is not accessible or not
 *   a directory, if `target` escapes `root`, or if any segment from `root`
 *   to `target` (whether freshly created or pre-existing) fails `contract`.
 */
export async function ensureTrustedDirChain(
  root: string,
  target: string,
  contract: TrustedSegmentContract,
  deps: TrustedDirDeps = defaultDeps,
): Promise<void> {
  let rootSt: TrustedDirStats;
  try {
    rootSt = await deps.stat(root);
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    failAndThrow({ root, err }, `trusted root is not accessible: ${root} (${code ?? String(err)})`);
  }
  if (!rootSt.isDirectory()) {
    failAndThrow({ root }, `trusted root is not a directory: ${root}`);
  }

  const rel = path.relative(root, target);
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    failAndThrow({ root, target }, `target ${target} escapes the trusted root ${root}`);
  }

  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await deps.mkdir(current, contract.mkdirMode !== undefined ? { mode: contract.mkdirMode } : undefined);
    } catch (err) {
      // Non-recursive `mkdir` throws EEXIST when `current` already exists (as
      // a plain directory, a symlink, or a regular file) -- exactly the case
      // the `lstat` check below exists to accept or reject. Any other mkdir
      // failure (e.g. EACCES) is a genuine I/O failure and propagates
      // unwrapped.
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    const st = await deps.lstat(current);
    if (st.isSymbolicLink()) {
      failAndThrow({ dir: current }, `Trusted directory segment is a symlink: ${current}`);
    }
    if (!st.isDirectory()) {
      failAndThrow({ dir: current }, `Trusted directory segment is not a directory: ${current}`);
    }
    if (contract.expectedUid !== null && st.uid !== contract.expectedUid) {
      failAndThrow(
        { dir: current, uid: st.uid },
        `Trusted directory segment has unexpected owner uid=${st.uid} (expected ${contract.expectedUid}): ${current}`,
      );
    }
    if (contract.expectedGid !== null && st.gid !== contract.expectedGid) {
      failAndThrow(
        { dir: current, gid: st.gid },
        `Trusted directory segment has unexpected group gid=${st.gid} (expected ${contract.expectedGid}): ${current}`,
      );
    }
    if (contract.mode !== null && (st.mode & 0o7777) !== contract.mode) {
      const actualMode = st.mode & 0o7777;
      failAndThrow(
        { dir: current, actualMode: actualMode.toString(8), expectedMode: contract.mode.toString(8) },
        `Trusted directory segment has unexpected mode ${actualMode.toString(8)} (expected ${contract.mode.toString(8)}): ${current}`,
      );
    }
  }
}
