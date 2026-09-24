/**
 * Memory layer (epic #1636 Phase 2): server-owned, created and verified on
 * every activation, never trusted from a prior `mkdir` call.
 *
 * See docs/design/embedded-agent-worker.md "Ownership and location" for the
 * full spec this module implements. Two properties transfer from
 * `routes/workers.ts`'s `ensureUploadDir` (the upload directory's own
 * created-by-the-server-and-verified pattern), and one does NOT:
 *
 *   - Transfers: verify on EVERY call (no readiness cache). The walk is
 *     `ensureTrustedDirChain` (`trusted-dir.ts`), and covers every segment
 *     from `configDir` down to the leaf -- the trusted base's own
 *     ancestors, the trusted base itself, and the memory leaf -- not only
 *     the leaf itself, unlike `ensureUploadDir` (whose target is always a
 *     single leaf segment under an already-trusted parent). See
 *     `ensureMemoryDir`'s own header for why.
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
import { realpath } from 'fs/promises';
import * as path from 'path';
import { computeQuickCwdSlug } from './session-data-path.js';
import type { SessionDataPathResolver } from './session-data-path-resolver.js';
import type { InternalSession } from '../services/internal-types.js';
import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import { ensureTrustedDirChain, resolveAncestorContract, TrustedDirVerificationError } from './trusted-dir.js';

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
 * Create (idempotently) and verify the memory directory at `dir`, walking
 * every path segment from `trustedRoot` (the session-data root, i.e.
 * `configDir`) down to the leaf, through `ensureTrustedDirChain`
 * (`trusted-dir.ts`).
 *
 * **Why every segment, not just the leaf (CodeRabbit MAJOR, #1691).** A
 * recursive `mkdir` follows an intermediate symlink at any ANCESTOR of
 * `dir` (e.g. `<base>/memory` itself, or `<base>/memory/<defId>` on the
 * quick-session shape) and creates/confirms the LEAF inside whatever the
 * symlink points at. Every server-created directory under the data root is
 * `2775` group-writable, so a group member can pre-plant such a symlink
 * before the server ever runs, and the leaf then passes every check because
 * it genuinely is a correctly-owned `2775` directory -- just not the one
 * under `dir`'s real path. Walking and verifying every segment closes that:
 * see `trusted-dir.ts`'s own header for the non-recursive, per-segment
 * mechanism this delegates to.
 *
 * **Accepted residue.** See `trusted-dir.ts`'s module header for the full
 * statement (pre-planted-only defense, no TOCTOU protection, the `2775`
 * team-of-trust model this stays inside of).
 *
 * Multi-user mode calls `mkdir` with NO `mode` argument on the leaf walk's
 * segments: every segment inherits the data root's `2775` setgid contract
 * via the systemd unit's `UMask=0002` (spec "permission contract").
 * Single-user mode passes `mode: 0o700` explicitly on each leaf segment.
 *
 * @param dir the full memory directory path to ensure and verify.
 * @param trustedBase the session's own base dir (`SessionDataPathResolver
 *   .getBaseDir()`) -- the point from which the leaf walk verifies every
 *   segment down to `dir`. Verified itself, as an ancestor walk from
 *   `trustedRoot`, with the uid-only contract (`resolveAncestorContract`).
 * @param trustedRoot the session-data root (`configDir`,
 *   `SessionDataPathResolver.getTrustedRoot()`) -- trusted by definition,
 *   never created here.
 * @throws {MemoryDirVerificationError} if `trustedRoot` fails its own
 *   check, if `trustedBase` fails the ancestor walk, if `dir` is not under
 *   `trustedBase`, or if any segment from `trustedBase` to the leaf
 *   (whether freshly created or pre-existing) does not satisfy `contract`
 *   exactly.
 */
export async function ensureMemoryDir(
  dir: string,
  trustedBase: string,
  trustedRoot: string,
  contract: MemoryDirContract = resolveMemoryDirContract(),
): Promise<void> {
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  try {
    // Ancestors: configDir -> ... -> trustedBase (uid-only contract, R3 in
    // the walker's own header).
    await ensureTrustedDirChain(trustedRoot, trustedBase, resolveAncestorContract());
    // Leaf walk: trustedBase -> ... -> dir, the memory contract exactly as
    // before (exact mode, gid in multi-user, 0o700 mkdir mode in
    // single-user, umask/setgid inherit in multi-user).
    await ensureTrustedDirChain(trustedBase, dir, {
      expectedUid: euid,
      expectedGid: contract.expectedGid,
      mode: contract.mode,
      mkdirMode: contract.mode === MULTI_USER_MEMORY_DIR_MODE ? undefined : contract.mode,
    });
  } catch (err) {
    // Callers and the elevation smoke pin `MemoryDirVerificationError`;
    // rewrap preserving the walker's message (the ONLY permitted handling
    // of `TrustedDirVerificationError` anywhere).
    if (err instanceof TrustedDirVerificationError) throw new MemoryDirVerificationError(err.message);
    throw err;
  }
}

/**
 * Resolve the memory directory path for a session/definition pair, without
 * creating or verifying it. Quick sessions key on
 * `computeQuickCwdSlug(realpath(session.locationPath))`; repository
 * (worktree) sessions key on (definition, repository) alone.
 *
 * `realpath` failures fall back to `path.resolve` so this stays usable
 * outside a real filesystem, on two triggers: a nonexistent path (test
 * fixtures) and EACCES when the server process cannot traverse the path (a
 * quick session's directory under the multi-user `0700`-home default is
 * unreadable by the server process, even though the path exists and the
 * session works). Consequence: the memory directory key is then the path as
 * given, so a symlink alias of a quick session's directory resolves to a
 * separate memory directory than its target would.
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
  await ensureMemoryDir(dir, resolver.getBaseDir(), resolver.getTrustedRoot());
  return dir;
};
