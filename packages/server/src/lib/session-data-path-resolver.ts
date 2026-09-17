/**
 * SessionDataPathResolver — thin wrapper around a precomputed base directory
 * and the trusted root every path under it is verified against on the inode
 * chain at creation time (`ensureTrustedDirChain` in `trusted-dir.ts`).
 *
 * The base directory is always computed via `computeSessionDataBaseDir` in
 * `session-data-path.ts`. See `docs/design/session-data-path.md` for the spec.
 */
import * as path from 'path';
import { assertValidSegment } from './session-data-path.js';

/**
 * Discriminates the two `memoryDir` shapes the memory layer (epic #1636
 * Phase 2) uses. `repository` sessions key memory by (definition,
 * repository); `quick` sessions have no repository to key on and add a
 * `cwd-slug` (see `computeQuickCwdSlug` in `session-data-path.ts`).
 *
 * See `docs/design/embedded-agent-worker.md` "Ownership and location" for
 * the table this type mirrors.
 */
export type MemoryDirScope = { kind: 'repository' } | { kind: 'quick'; cwdSlug: string };

export class SessionDataPathResolver {
  constructor(
    private readonly baseDir: string,
    private readonly trustedRoot: string,
  ) {}

  getMessagesDir(): string {
    return path.join(this.baseDir, 'messages');
  }

  getMemosDir(): string {
    return path.join(this.baseDir, 'memos');
  }

  getMemosPath(sessionId: string): string {
    return path.join(this.getMemosDir(), `${sessionId}.md`);
  }

  getOutputsDir(): string {
    return path.join(this.baseDir, 'outputs');
  }

  getOutputFilePath(sessionId: string, workerId: string): string {
    return path.join(this.getOutputsDir(), sessionId, `${workerId}.log`);
  }

  /** Exposed so `ensureMemoryDir` and every other session-data creator can walk from the trusted base. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * The root every session-data path is verified against on the inode
   * chain (`ensureTrustedDirChain` in `trusted-dir.ts`). Production passes
   * the same `configDir` the base was computed from.
   */
  getTrustedRoot(): string {
    return this.trustedRoot;
  }

  /**
   * Memory layer (epic #1636 Phase 2). Single writer of the memory path,
   * alongside `getOutputsDir` / `getMessagesDir` / `getMemosDir` above.
   *
   * | Session scope | path |
   * |---|---|
   * | `repository` | `<baseDir>/memory/<definitionId>/` |
   * | `quick` | `<baseDir>/memory/<definitionId>/<cwd-slug>/` |
   *
   * Memory sits INSIDE the session-data address (a sibling of `outputs/`,
   * `messages/`, `memos/`) rather than a new top-level namespace, because
   * repository deletion already removes the whole base dir
   * (`buildSessionDataCleanupTargets`), and session deletion only removes
   * `outputs/<sessionId>` — `memory/` is a sibling it never touches. See
   * docs/design/embedded-agent-worker.md "Ownership and location" / "Q7
   * lifecycle".
   *
   * `definitionId` and (quick scope) `cwdSlug` must each be a single path
   * segment (no `/`, never `.` / `..`) — the same guarantee every other
   * path this resolver produces relies on staying under `baseDir`.
   *
   * @throws {InvalidSessionDataScopeError} if `definitionId` or `cwdSlug`
   *   is not a valid single path segment.
   */
  getMemoryDir(definitionId: string, scope: MemoryDirScope): string {
    assertValidSegment(definitionId, 'definitionId');
    if (scope.kind === 'quick') {
      assertValidSegment(scope.cwdSlug, 'cwdSlug');
      return path.join(this.baseDir, 'memory', definitionId, scope.cwdSlug);
    }
    return path.join(this.baseDir, 'memory', definitionId);
  }
}
