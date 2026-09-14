/**
 * Memory layer (epic #1636 Phase 2): server-owned, created and verified on
 * every activation, never trusted from a prior `mkdir` call.
 *
 * See docs/design/embedded-agent-worker.md "Ownership and location" for the
 * full spec this module implements. Two properties transfer from
 * `routes/workers.ts`'s `ensureUploadDir` (the upload directory's own
 * created-by-the-server-and-verified pattern), and one does NOT:
 *
 *   - Transfers: verify on EVERY call (no readiness cache) via `lstat` —
 *     reject a symlink, a non-directory, an unexpected owner uid, an
 *     unexpected group gid, or a mode that is not EXACTLY the contract's
 *     value. Unlike `ensureUploadDir` (whose target is always a single leaf
 *     segment under an already-trusted parent), this verification walks and
 *     checks EVERY segment from the trusted base down to the leaf, not only
 *     the leaf itself -- see `ensureMemoryDir`'s own header for why.
 *   - Does NOT transfer: `ensureUploadDir`'s explicit multi-user
 *     `mode: 0o2750` + `chmod(1)` shell-out. Those exist to make the upload
 *     dir NARROWER than the umask default (read+traverse only, never
 *     write). The memory directory needs the WIDER `2775` data-root
 *     convention (setgid + group-rw), inherited for free from the systemd
 *     unit's `UMask=0002` by calling `mkdir` with NO `mode` argument at all
 *     in multi-user mode — never re-derived, never chmod'd into place.
 *     The gid check below passes only because the unit template sets
 *     `Group=<service group>` next to `UMask=0002`: a unit missing `Group=`
 *     runs with the service user's private group, and every embedded
 *     activation then fails with the "unexpected group gid" message —
 *     correct fail-closed behaviour that no fixture here can see; 3b's
 *     real-host smoke must read the unit's `Group=`.
 */
import { mkdir, lstat, realpath } from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { computeQuickCwdSlug } from './session-data-path.js';
import type { SessionDataPathResolver } from './session-data-path-resolver.js';
import type { InternalSession } from '../services/internal-types.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';

const logger = createLogger('memory-dir');

const SINGLE_USER_MEMORY_DIR_MODE = 0o700;
const MULTI_USER_MEMORY_DIR_MODE = 0o2775;

export interface MemoryDirContract {
  mode: number;
  expectedGid: number | null;
}

/**
 * Resolves the mode/gid contract the memory directory must satisfy, read
 * from the environment at call time (same shape as `routes/workers.ts`'s
 * `resolveUploadDirContract` — never cached, never read from
 * `serverConfig` at module-load time).
 */
export function resolveMemoryDirContract(): MemoryDirContract {
  if (process.env.AUTH_MODE === 'multi-user' && typeof process.getgid === 'function') {
    return { mode: MULTI_USER_MEMORY_DIR_MODE, expectedGid: process.getgid() };
  }
  return { mode: SINGLE_USER_MEMORY_DIR_MODE, expectedGid: null };
}

export class MemoryDirVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryDirVerificationError';
  }
}

/**
 * Verify a single segment (`current`) after it has been created/confirmed:
 * reject a symlink, a non-directory, an unexpected owner uid, an unexpected
 * group gid, or a mode that is not EXACTLY `contract.mode`.
 *
 * This post-mkdir check is VERIFICATION, not configuration: the umask sets
 * the mode, the check confirms the directory the server is about to hand
 * the model is the one it created (a pre-created symlink or a wider-mode
 * directory must never slip past mkdir's no-op). It is therefore NOT
 * redundant with the umask and must not be removed as such.
 */
async function verifySegment(current: string, contract: MemoryDirContract): Promise<void> {
  const st = await lstat(current);
  if (st.isSymbolicLink()) {
    const message = `Memory directory is a symlink: ${current}`;
    logger.error({ dir: current }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (!st.isDirectory()) {
    const message = `Memory directory path is not a directory: ${current}`;
    logger.error({ dir: current }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) {
    const message = `Memory directory has unexpected owner uid=${st.uid} (expected ${process.geteuid()}): ${current}`;
    logger.error({ dir: current, uid: st.uid }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (contract.expectedGid !== null && st.gid !== contract.expectedGid) {
    const message = `Memory directory has unexpected group gid=${st.gid} (expected ${contract.expectedGid}): ${current}`;
    logger.error({ dir: current, gid: st.gid }, message);
    throw new MemoryDirVerificationError(message);
  }
  const actualMode = st.mode & 0o7777;
  if (actualMode !== contract.mode) {
    const message = `Memory directory has unexpected mode ${actualMode.toString(8)} (expected ${contract.mode.toString(8)}): ${current}`;
    logger.error({ dir: current, actualMode: actualMode.toString(8), expectedMode: contract.mode.toString(8) }, message);
    throw new MemoryDirVerificationError(message);
  }
}

/**
 * Create (idempotently) and verify the memory directory at `dir`, walking
 * every path segment from `trustedBase` down to the leaf.
 *
 * **Why every segment, not just the leaf (CodeRabbit MAJOR, #1691).** The
 * original single-`lstat`-on-the-leaf shape followed intermediate symlinks:
 * `mkdir(dir, { recursive: true })` walks through a pre-existing symlink at
 * any ANCESTOR of `dir` (e.g. `<base>/memory` itself, or `<base>/memory/
 * <defId>` on the quick-session shape) and creates/confirms the LEAF inside
 * whatever the symlink points at. Every server-created directory under the
 * data root is `2775` group-writable, so a group member can pre-plant such
 * a symlink before the server ever runs, and the leaf then passes every
 * check because it genuinely is a correctly-owned `2775` directory --
 * just not the one under `dir`'s real path. Walking and verifying every
 * segment closes that: `mkdir` for each segment is now NON-recursive
 * (`{ recursive: true }` removed), so it fails on anything but a fresh
 * segment or a segment that already exists as a plain directory, and each
 * segment is `lstat`-verified (symlink rejected) BEFORE the walk descends
 * into it.
 *
 * **Accepted residue, stated so nobody "hardens" this into a half-measure
 * later.** This defends against a symlink PRE-PLANTED before this call
 * runs. It does NOT defend against a symlink swapped in between this
 * function's `lstat` of a segment and a later use of that path (a
 * TOCTOU race) -- no `O_NOFOLLOW` / `openat`-relative-fd chain is
 * attempted here. A group member racing that narrow window is inside the
 * team-of-trust model the `2775` contract already accepts (spec D1: any
 * group member may already read/write/replace files under this directory
 * once it exists); this function's job is only to stop a PRE-PLANTED
 * symlink from silently redirecting the directory the server will hand to
 * the model. Separately, `trustedBase` itself sits under ancestors this
 * function does NOT verify -- `DATA_ROOT/_quick` and
 * `DATA_ROOT/repositories/<slug>` are created by `worker-output-file.ts`'s
 * own recursive `mkdir` and carry the identical pre-existing exposure this
 * function closes for `memory/` and below. That is a pre-existing
 * session-data exposure, not introduced or fixed by this module; tracked
 * as a follow-up rather than covered here.
 *
 * Multi-user mode calls `mkdir` with NO `mode` argument on each segment:
 * every segment inherits the data root's `2775` setgid contract via the
 * systemd unit's `UMask=0002` (spec "permission contract"). Single-user
 * mode passes `mode: 0o700` explicitly on each segment.
 *
 * @param dir the full memory directory path to ensure and verify.
 * @param trustedBase the session's own base dir (`SessionDataPathResolver
 *   .getBaseDir()`) -- the point from which every segment is walked and
 *   verified. Created if absent, then verified: must be a directory and
 *   not be a symlink (no uid/mode assertion on it; it predates this
 *   contract and is out of scope here).
 * @throws {MemoryDirVerificationError} if `trustedBase` fails its own
 *   check, if `dir` is not under `trustedBase`, or if any segment from
 *   `trustedBase` to the leaf (whether freshly created or pre-existing)
 *   does not satisfy `contract` exactly.
 */
export async function ensureMemoryDir(
  dir: string,
  trustedBase: string,
  contract: MemoryDirContract = resolveMemoryDirContract(),
): Promise<void> {
  // `trustedBase` (`<configDir>/_quick` or `<configDir>/repositories/<slug>`)
  // is not guaranteed to exist yet: `runActivation` calls this before
  // `resetWorkerOutput`, and nothing in `createSession` creates the base --
  // it is created lazily by whichever of outputs/messages/memos writes
  // first. A brand-new session's first activation (no message sent yet)
  // would otherwise hit this function's own base `lstat` before any of
  // those siblings ever run, and fail with a raw ENOENT.
  //
  // `recursive: true` is acceptable HERE, and only here, unlike the
  // non-recursive per-segment walk below: `trustedBase` is the one path in
  // this function that this codebase's other session-data writers
  // (worker-output-file.ts, memo-service.ts,
  // inter-session-message-service.ts) already create with this exact
  // recursive shape, so this adds no new exposure beyond the pre-existing
  // above-base one already recorded as a follow-up in this function's own
  // header (the ancestors of `trustedBase` itself). It does NOT weaken the
  // symlink defense this function exists for: a pre-planted symlink AT
  // `trustedBase` still gets caught by the `lstat` check immediately
  // below -- `mkdir(..., { recursive: true })` is a no-op when the target
  // already exists (as a directory OR as a symlink resolving to one), so a
  // symlinked base reaches the `isSymbolicLink()` check unchanged.
  try {
    await mkdir(trustedBase, { recursive: true });
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }

  const baseSt = await lstat(trustedBase);
  if (baseSt.isSymbolicLink()) {
    const message = `Memory directory trusted base is a symlink: ${trustedBase}`;
    logger.error({ trustedBase }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (!baseSt.isDirectory()) {
    const message = `Memory directory trusted base is not a directory: ${trustedBase}`;
    logger.error({ trustedBase }, message);
    throw new MemoryDirVerificationError(message);
  }

  const rel = path.relative(trustedBase, dir);
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    const message = `Memory directory ${dir} escapes the trusted base ${trustedBase}`;
    logger.error({ dir, trustedBase }, message);
    throw new MemoryDirVerificationError(message);
  }

  let current = trustedBase;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (contract.mode === MULTI_USER_MEMORY_DIR_MODE) {
        await mkdir(current);
      } else {
        await mkdir(current, { mode: contract.mode });
      }
    } catch (err) {
      // Non-recursive `mkdir` throws EEXIST when `current` already exists
      // (as a plain directory, a symlink, or a regular file) -- exactly the
      // case `verifySegment` below exists to accept or reject. Any other
      // mkdir failure (e.g. EACCES, or ENOENT because an ancestor is
      // missing -- unreachable here since segments are created in order) is
      // a genuine failure and propagates unwrapped.
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    await verifySegment(current, contract);
  }
}

/**
 * Resolve the memory directory path for a session/definition pair, without
 * creating or verifying it. Quick sessions key on
 * `computeQuickCwdSlug(realpath(session.locationPath))`; repository
 * (worktree) sessions key on (definition, repository) alone.
 *
 * `realpath` failures (test fixtures using nonexistent paths) fall back to
 * `path.resolve` so this stays usable outside a real filesystem.
 */
export async function resolveMemoryDirPath(params: {
  session: Pick<InternalSession, 'type' | 'locationPath'>;
  definitionId: string;
  resolver: Pick<SessionDataPathResolver, 'getMemoryDir'>;
}): Promise<string> {
  const { session, definitionId, resolver } = params;
  if (session.type === 'quick') {
    let realCwd: string;
    try {
      realCwd = await realpath(session.locationPath);
    } catch {
      realCwd = path.resolve(session.locationPath);
    }
    const cwdSlug = computeQuickCwdSlug(realCwd);
    return resolver.getMemoryDir(definitionId, { kind: 'quick', cwdSlug });
  }
  return resolver.getMemoryDir(definitionId, { kind: 'repository' });
}

/** Test/polarity seam type for {@link EmbeddedAgentWorkerServiceDeps.ensureMemoryDirFn}. */
export type EnsureMemoryDirFn = (params: {
  session: InternalSession;
  definition: EmbeddedAgentDefinition;
  resolver: SessionDataPathResolver;
}) => Promise<string | undefined>;

/**
 * Default `EnsureMemoryDirFn`: resolves the path, creates it idempotently,
 * verifies it, and returns it. Never returns `undefined` in production —
 * the polarity seam that does is `--expect-no-memory`'s wrapped override.
 */
export const prepareMemoryDir: EnsureMemoryDirFn = async ({ session, definition, resolver }) => {
  const dir = await resolveMemoryDirPath({ session, definitionId: definition.id, resolver });
  await ensureMemoryDir(dir, resolver.getBaseDir());
  return dir;
};
