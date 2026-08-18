import type { Artifact, NotificationItem } from '@agent-console/shared';
import { JOB_TYPES, JOB_STATUS, type WorktreeDeletePayload } from '@agent-console/shared';
import type { ArtifactRepository } from '../repositories/artifact-repository.js';
import type { NotificationCursorRepository } from '../repositories/notification-cursor-repository.js';
import type { JobQueue } from '../jobs/job-queue.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('notification-service');

/** Wire response cap (spec §8: "v1: 50, an accepted cut; no pagination"). */
const FEED_CAP = 50;
/** Per-source fetch limit BEFORE merge+sort (R4.6: cap is applied AFTER merge+sort, not per-source). */
const PER_SOURCE_FETCH_LIMIT = 50;

/**
 * Identity seam for personal-feed filtering (R3) — resolved ONCE at the
 * route, passed to every composer. Each composer declares which key it
 * filters by; no per-source ad-hoc identity derivation.
 */
export interface FeedIdentity {
  userId: string;
  username: string;
}

/**
 * Notification service dependencies (R1). READ interfaces only, plus the
 * cursor repository (the one writer this service uses, for the cursor
 * only). Deliberately has NO broadcast/WS/event member — this makes N1
 * ("a broadcast is never a source of list content") unrepresentable in the
 * type, not merely forbidden in prose.
 */
export interface NotificationServiceDeps {
  artifactRepository: Pick<ArtifactRepository, 'findByUserId'>;
  jobs: Pick<JobQueue, 'getJobs'>;
  cursorRepository: NotificationCursorRepository;
}

type ComposerFn = (identity: FeedIdentity, deps: NotificationServiceDeps) => Promise<NotificationItem[]>;

async function composeArtifactCreated(identity: FeedIdentity, deps: NotificationServiceDeps): Promise<NotificationItem[]> {
  const artifacts: Artifact[] = await deps.artifactRepository.findByUserId(identity.userId);
  // findByUserId already returns newest-first; cap here (fetch-then-slice,
  // not push-down) per R4.6.
  return artifacts.slice(0, PER_SOURCE_FETCH_LIMIT).map((a) => ({
    kind: 'artifact-created' as const,
    id: a.id,
    occurredAt: a.createdAt,
    title: a.title,
    link: `/artifacts/${a.id}`,
  }));
}

function isWorktreeDeletePayload(payload: unknown): payload is WorktreeDeletePayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.jobId === 'string' &&
    typeof p.repoId === 'string' &&
    typeof p.worktreePath === 'string' &&
    typeof p.force === 'boolean' &&
    (p.requestUsername === null || typeof p.requestUsername === 'string')
  );
}

async function composeWorktreeDeletionFinished(identity: FeedIdentity, deps: NotificationServiceDeps): Promise<NotificationItem[]> {
  // R-3 fix: unlike the artifact composer's `findByUserId` (already
  // user-scoped, so PER_SOURCE_FETCH_LIMIT-slicing afterward is safe), the
  // job queue has NO per-user scoping -- `getJobs` returns the N most recent
  // jobs of this type ACROSS ALL USERS. Fetching by type with a tight limit
  // and filtering by username afterward would evict the caller's own
  // (possibly older) job from the fetch window before the username filter
  // ever runs, once other users collectively produced more than the limit's
  // worth of more-recent worktree:delete jobs. worktree:delete is a
  // low-frequency job type, so fetching without a limit is acceptable in v1;
  // the final FEED_CAP slice in getFeed (applied AFTER merge+sort across all
  // sources) is what bounds the response size, not this fetch.
  //
  // Status is filtered at the fetch (COMPLETED + STALLED only, the two
  // terminal statuses this feed shows per R4.5) rather than fetching every
  // status and discarding non-terminal rows in the loop below. This is safe
  // alongside the R-3 fix above: status filtering is not per-user scoping,
  // so narrowing by status cannot reintroduce the eviction bug -- it only
  // reduces rows fetched (pending/processing jobs never appear in the feed
  // regardless of how many exist) as job history grows.
  const [completedJobs, stalledJobs] = await Promise.all([
    deps.jobs.getJobs({ type: JOB_TYPES.WORKTREE_DELETE, status: JOB_STATUS.COMPLETED }),
    deps.jobs.getJobs({ type: JOB_TYPES.WORKTREE_DELETE, status: JOB_STATUS.STALLED }),
  ]);
  const jobs = [...completedJobs, ...stalledJobs];
  const items: NotificationItem[] = [];

  for (const job of jobs) {
    let payload: unknown;
    try {
      payload = JSON.parse(job.payload);
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'Skipping worktree:delete job with unparseable payload');
      continue;
    }
    if (!isWorktreeDeletePayload(payload)) {
      logger.warn({ jobId: job.id }, 'Skipping worktree:delete job with a payload shape that does not narrow to WorktreeDeletePayload');
      continue;
    }

    // R3: deletion jobs filter by username. requestUsername is an
    // attribution PROXY -- it exists for privilege elevation, not identity
    // attribution. The durable fix (future job payloads carrying the
    // initiating users.id) triggers when a THIRD username-keyed source
    // appears, or any username-remapping feature lands. null requestUsername
    // matches nobody (legacy/edge rows).
    if (payload.requestUsername === null || payload.requestUsername !== identity.username) continue;

    const occurredAtMs = job.completed_at ?? job.started_at ?? job.created_at;
    const worktreeName = payload.worktreePath.split('/').filter(Boolean).pop() ?? payload.worktreePath;
    const outcome: 'completed' | 'failed' = job.status === JOB_STATUS.COMPLETED ? 'completed' : 'failed';

    items.push({
      kind: 'worktree-deletion-finished',
      id: job.id,
      occurredAt: new Date(occurredAtMs).toISOString(),
      title: outcome === 'completed' ? `Worktree deleted: ${worktreeName}` : `Worktree deletion failed: ${worktreeName}`,
      link: `/worktree-deletion-tasks/${job.id}`,
      outcome,
    });
  }

  return items;
}

/**
 * The per-source composer registry (R1) — the §4 admission rule's
 * enforcement point. Adding a new source is one entry here.
 */
const SOURCES: ReadonlyArray<ComposerFn> = [composeArtifactCreated, composeWorktreeDeletionFinished];

function compareNotificationItems(a: NotificationItem, b: NotificationItem): number {
  // R4.2: deterministic tie-break — occurredAt desc, then kind, then id.
  if (a.occurredAt !== b.occurredAt) return a.occurredAt > b.occurredAt ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The composed notification read-model (docs/design/notification-center.md
 * §3) — no notification rows are written; every call composes from domain
 * rows read at request time (N1).
 */
export class NotificationService {
  constructor(private deps: NotificationServiceDeps) {}

  async getFeed(identity: FeedIdentity): Promise<{ items: NotificationItem[]; lastSeenAt: string | null; unreadCount: number }> {
    // Two separate Promise.all calls rather than one mixed-type tuple: a
    // spread of SOURCES.map(...) into an array literal loses tuple-ness in
    // TypeScript's inference, which would widen lastSeenAt's type
    // incorrectly. Correctness over a single-call shape.
    const [lastSeenAt, sourceResults] = await Promise.all([
      this.deps.cursorRepository.getCursor(identity.userId),
      Promise.all(SOURCES.map((source) => source(identity, this.deps))),
    ]);

    const merged = sourceResults.flat().sort(compareNotificationItems);

    // R4.1: tie AT the cursor is seen — occurredAt > lastSeenAt STRICTLY.
    // Absent cursor (never opened the bell) => everything is unread.
    const unreadCount = merged.filter((item) => lastSeenAt === null || item.occurredAt > lastSeenAt).length;

    // R4.6: cap applied AFTER merge+sort, not per-source.
    const items = merged.slice(0, FEED_CAP);

    return { items, lastSeenAt, unreadCount };
  }
}
