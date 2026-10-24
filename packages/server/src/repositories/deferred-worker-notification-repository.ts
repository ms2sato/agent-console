import type { PtyNotificationKind } from '@agent-console/shared';

/**
 * A row to store: a notification addressed to a worker of a paused (or pausing)
 * session. `kind` is constrained here, in the type, never by a database CHECK.
 */
export interface NewDeferredWorkerNotification {
  id: string;
  sessionId: string;
  workerId: string;
  kind: PtyNotificationKind;
  /** Polymorphic provenance, no foreign key: inbound job id, message file path, process id, digest file path. */
  sourceId: string | null;
  /** The notification seam's `PtyNotificationParams` serialised as JSON. */
  paramsJson: string;
  /** Sender session of an inter-session message; the database sets it NULL when that session is deleted. */
  replyToSessionId: string | null;
  /** ISO 8601 UTC (`...Z`); rows are ordered by this, then by `id`. */
  createdAt: string;
}

/** A stored row as read back. `kind` is the text that was written. */
export interface DeferredWorkerNotificationRecord extends Omit<NewDeferredWorkerNotification, 'kind'> {
  kind: string;
}

/**
 * Persistence for notifications deferred while a session is paused. Rows are
 * never coalesced or upserted: every notification is its own row.
 */
export interface DeferredWorkerNotificationRepository {
  /**
   * Insert one row and, in the SAME transaction, delete the oldest rows of the
   * session beyond `cap` (ordered by `created_at`, then `id`). A dropped row is
   * logged at warn with its kind.
   */
  insert(row: NewDeferredWorkerNotification, cap: number): Promise<void>;

  /** All rows of a session, oldest first (`created_at`, then `id`). */
  listBySession(sessionId: string): Promise<DeferredWorkerNotificationRecord[]>;

  /** Delete rows by id; returns the number deleted. An empty list is a no-op. */
  deleteByIds(ids: string[]): Promise<number>;

  countBySession(sessionId: string): Promise<number>;
}
