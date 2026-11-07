/**
 * SessionDataPathResolver — thin wrapper around a precomputed base directory
 * and the trusted root every path under it is verified against on the inode
 * chain at creation time (`ensureTrustedDirChain` in `trusted-dir.ts`).
 *
 * The base directory is always computed via `computeSessionDataBaseDir` in
 * `session-data-path.ts`. See `docs/design/session-data-path.md` for the spec.
 */
import * as path from 'path';
import { assertValidSegment, InvalidSessionDataScopeError } from './session-data-path.js';

/** Longest attachment file name in UTF-8 bytes: 255 minus room for the writer's `.tmp` sibling. */
const MAX_ATTACHMENT_FILE_NAME_BYTES = 250;

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

  /**
   * Single writer of an inbound-webhook delivery's per-target file locations:
   * `<messagesDir>/<sessionId>/<workerId>/inbound-webhook/<deliveryId>/` with
   * the untrusted sender file `body.md`, the operator-trusted `instruction.md`
   * and the `attachments/` directory inside it. The notification handler (which
   * tells the agent the paths) and the writer of the files both call this, so
   * the two cannot drift. `deliveryId` is `inbound-webhook:<endpointId>:<webhookId>`,
   * so a colon is allowed in that one segment; every segment is otherwise the same
   * single-segment shape as the rest of this resolver.
   *
   * @throws {InvalidSessionDataScopeError} if a segment is not a valid single path segment.
   */
  getInboundWebhookDeliveryPaths(
    sessionId: string,
    workerId: string,
    deliveryId: string,
  ): { dir: string; bodyPath: string; instructionPath: string; attachmentsDir: string } {
    assertValidSegment(sessionId, 'sessionId');
    assertValidSegment(workerId, 'workerId');
    assertValidSegment(deliveryId.replace(/:/g, '-'), 'deliveryId');
    const dir = path.join(this.getMessagesDir(), sessionId, workerId, 'inbound-webhook', deliveryId);
    return {
      dir,
      bodyPath: path.join(dir, 'body.md'),
      instructionPath: path.join(dir, 'instruction.md'),
      attachmentsDir: path.join(dir, 'attachments'),
    };
  }

  /**
   * Location of one attachment file inside a delivery's `attachments/` directory. The file name
   * comes from the sender (already sanitized upstream); it is verified here as well, as a single
   * path segment: non-empty, not `.` / `..`, no `/`, `\`, NUL or control character, and short
   * enough that the writer's `.tmp` sibling still fits a 255-byte file name.
   *
   * @throws {InvalidSessionDataScopeError} if any segment is not a valid single path segment.
   */
  getInboundWebhookAttachmentPath(sessionId: string, workerId: string, deliveryId: string, fileName: string): string {
    const { attachmentsDir } = this.getInboundWebhookDeliveryPaths(sessionId, workerId, deliveryId);
    if (
      fileName === '' ||
      fileName === '.' ||
      fileName === '..' ||
      /[/\\\u0000-\u001f\u007f]/.test(fileName) ||
      Buffer.byteLength(fileName, 'utf-8') > MAX_ATTACHMENT_FILE_NAME_BYTES
    ) {
      throw new InvalidSessionDataScopeError('attachment file name is not a valid single path segment');
    }
    return path.join(attachmentsDir, fileName);
  }

  /** Read-more files listing what was deferred while the session was paused (one `<resumedAt>.md` per resume). */
  getDeferredDir(): string {
    return path.join(this.baseDir, 'deferred');
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
