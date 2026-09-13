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
 *     value.
 *   - Does NOT transfer: `ensureUploadDir`'s explicit multi-user
 *     `mode: 0o2750` + `chmod(1)` shell-out. Those exist to make the upload
 *     dir NARROWER than the umask default (read+traverse only, never
 *     write). The memory directory needs the WIDER `2775` data-root
 *     convention (setgid + group-rw), inherited for free from the systemd
 *     unit's `UMask=0002` by calling `mkdir` with NO `mode` argument at all
 *     in multi-user mode — never re-derived, never chmod'd into place.
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
 * Create (idempotently) and verify the memory directory at `dir`.
 *
 * Multi-user mode calls `mkdir` with NO `mode` argument: the directory
 * inherits the data root's `2775` setgid contract via the systemd unit's
 * `UMask=0002` (spec "permission contract"). Single-user mode passes
 * `mode: 0o700` explicitly.
 *
 * @throws {MemoryDirVerificationError} if the directory at `dir` (whether
 *   freshly created or pre-existing) does not satisfy `contract` exactly.
 */
export async function ensureMemoryDir(
  dir: string,
  contract: MemoryDirContract = resolveMemoryDirContract(),
): Promise<void> {
  try {
    if (contract.mode === MULTI_USER_MEMORY_DIR_MODE) {
      await mkdir(dir, { recursive: true });
    } else {
      await mkdir(dir, { recursive: true, mode: contract.mode });
    }
  } catch (err) {
    // `mkdir(..., { recursive: true })` is a no-op when `dir` already
    // exists as a directory, but throws EEXIST when a non-directory (a
    // symlink or a regular file) already occupies the path. That case is
    // exactly what the verification below exists to reject with a clear
    // message -- swallow EEXIST here and let lstat below produce it.
    // Any other mkdir failure (e.g. EACCES) is a genuine failure and
    // propagates unwrapped.
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }

  // This post-mkdir check is VERIFICATION, not configuration: the umask
  // sets the mode, the check confirms the directory the server is about to
  // hand the model is the one it created (a pre-created symlink or a
  // wider-mode directory must never slip past mkdir's no-op). It is
  // therefore NOT redundant with the umask and must not be removed as such.
  const st = await lstat(dir);
  if (st.isSymbolicLink()) {
    const message = `Memory directory is a symlink: ${dir}`;
    logger.error({ dir }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (!st.isDirectory()) {
    const message = `Memory directory path is not a directory: ${dir}`;
    logger.error({ dir }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) {
    const message = `Memory directory has unexpected owner uid=${st.uid} (expected ${process.geteuid()}): ${dir}`;
    logger.error({ dir, uid: st.uid }, message);
    throw new MemoryDirVerificationError(message);
  }
  if (contract.expectedGid !== null && st.gid !== contract.expectedGid) {
    const message = `Memory directory has unexpected group gid=${st.gid} (expected ${contract.expectedGid}): ${dir}`;
    logger.error({ dir, gid: st.gid }, message);
    throw new MemoryDirVerificationError(message);
  }
  const actualMode = st.mode & 0o7777;
  if (actualMode !== contract.mode) {
    const message = `Memory directory has unexpected mode ${actualMode.toString(8)} (expected ${contract.mode.toString(8)}): ${dir}`;
    logger.error({ dir, actualMode: actualMode.toString(8), expectedMode: contract.mode.toString(8) }, message);
    throw new MemoryDirVerificationError(message);
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
  await ensureMemoryDir(dir);
  return dir;
};
