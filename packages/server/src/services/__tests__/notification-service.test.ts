/**
 * Sibling test for `NotificationService` (Notification Center Phase 1,
 * Issue #1353). Every R4 boundary from the Issue's AC is a named test here.
 *
 * Uses in-memory fakes for all three deps (artifactRepository, jobs,
 * cursorRepository) -- a unit test per `.claude/rules/testing.md`'s
 * unit/integration split. The real SQL-backed cursor repository behavior
 * (R2's conditional upsert) is covered separately in
 * `repositories/__tests__/sqlite-notification-cursor-repository.test.ts`,
 * and the real wire-boundary in `packages/integration/`.
 */
import { describe, it, expect } from 'bun:test';
import type { Artifact, NotificationItem, WorktreeDeletePayload } from '@agent-console/shared';
import { JOB_TYPES, JOB_STATUS } from '@agent-console/shared';
import type { ArtifactRepository } from '../../repositories/artifact-repository.js';
import type { NotificationCursorRepository } from '../../repositories/notification-cursor-repository.js';
import type { JobQueue, JobRecord, GetJobsOptions } from '../../jobs/job-queue.js';
import { NotificationService, type NotificationServiceDeps, type FeedIdentity } from '../notification-service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeArtifactRepo(byUser: Record<string, Artifact[]>): Pick<ArtifactRepository, 'findByUserId'> {
  return {
    findByUserId: async (userId: string) => byUser[userId] ?? [],
  };
}

function makeJobsSource(jobs: JobRecord[]): Pick<JobQueue, 'getJobs'> {
  return {
    getJobs: async (options?: GetJobsOptions) => {
      let filtered = jobs;
      if (options?.type) filtered = filtered.filter((j) => j.type === options.type);
      if (options?.status) filtered = filtered.filter((j) => j.status === options.status);
      return options?.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
    },
  };
}

function makeCursorRepo(initial: Record<string, string | null> = {}): NotificationCursorRepository {
  const store = new Map<string, string>(Object.entries(initial).filter((e): e is [string, string] => e[1] !== null));
  return {
    getCursor: async (userId) => store.get(userId) ?? null,
    advance: async (userId, lastSeenAt) => {
      const current = store.get(userId);
      if (current === undefined || lastSeenAt > current) store.set(userId, lastSeenAt);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return store.get(userId)!;
    },
  };
}

function makeArtifact(overrides: Partial<Artifact> & { id: string }): Artifact {
  return {
    id: overrides.id,
    title: overrides.title ?? `Artifact ${overrides.id}`,
    createdAt: overrides.createdAt ?? '2026-08-18T00:00:00.000Z',
    sizeBytes: overrides.sizeBytes ?? 100,
  };
}

function makeWorktreeDeleteJob(overrides: {
  id: string;
  requestUsername: string | null;
  status?: JobRecord['status'];
  worktreePath?: string;
  completed_at?: number | null;
  started_at?: number | null;
  created_at?: number;
}): JobRecord {
  const payload: WorktreeDeletePayload = {
    jobId: overrides.id,
    repoId: 'repo-1',
    worktreePath: overrides.worktreePath ?? `/repos/repo-1/worktrees/${overrides.id}`,
    force: false,
    requestUsername: overrides.requestUsername,
  };
  return {
    id: overrides.id,
    type: JOB_TYPES.WORKTREE_DELETE,
    payload: JSON.stringify(payload),
    status: overrides.status ?? JOB_STATUS.COMPLETED,
    priority: 0,
    attempts: 1,
    max_attempts: 5,
    next_retry_at: 0,
    last_error: null,
    created_at: overrides.created_at ?? 1000,
    started_at: overrides.started_at ?? 1000,
    completed_at: overrides.completed_at !== undefined ? overrides.completed_at : 2000,
  };
}

const IDENTITY: FeedIdentity = { userId: 'user-1', username: 'alice' };

function buildService(overrides: {
  artifacts?: Record<string, Artifact[]>;
  jobs?: JobRecord[];
  cursor?: Record<string, string | null>;
} = {}): NotificationService {
  return new NotificationService({
    artifactRepository: makeArtifactRepo(overrides.artifacts ?? {}),
    jobs: makeJobsSource(overrides.jobs ?? []),
    cursorRepository: makeCursorRepo(overrides.cursor ?? {}),
  });
}

// ---------------------------------------------------------------------------
// N1 containment
// ---------------------------------------------------------------------------

describe('NotificationServiceDeps shape (N1 containment)', () => {
  it('has EXACTLY the three read-only members -- no broadcast/WS/event key can sneak in', () => {
    const deps: NotificationServiceDeps = {
      artifactRepository: makeArtifactRepo({}),
      jobs: makeJobsSource([]),
      cursorRepository: makeCursorRepo(),
    };
    expect(Object.keys(deps).sort()).toEqual(['artifactRepository', 'cursorRepository', 'jobs']);
  });
});

// ---------------------------------------------------------------------------
// R4 boundaries
// ---------------------------------------------------------------------------

describe('NotificationService.getFeed', () => {
  it('returns an empty feed when there are no artifacts and no jobs', async () => {
    const service = buildService();
    const result = await service.getFeed(IDENTITY);
    expect(result).toEqual({ items: [], lastSeenAt: null, unreadCount: 0 });
  });

  it('R4 setup: cursor absent (never opened the bell) -> all items are unread', async () => {
    const service = buildService({
      artifacts: { 'user-1': [makeArtifact({ id: 'a1', createdAt: '2026-08-18T00:00:00.000Z' })] },
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.lastSeenAt).toBeNull();
    expect(result.unreadCount).toBe(1);
  });

  it('cursor newer than every item -> unreadCount is 0', async () => {
    const service = buildService({
      artifacts: { 'user-1': [makeArtifact({ id: 'a1', createdAt: '2026-08-18T00:00:00.000Z' })] },
      cursor: { 'user-1': '2026-08-19T00:00:00.000Z' },
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.unreadCount).toBe(0);
  });

  it('R4.1: an item exactly AT the cursor timestamp is seen (strict >, not >=)', async () => {
    const service = buildService({
      artifacts: { 'user-1': [makeArtifact({ id: 'a1', createdAt: '2026-08-18T00:00:00.000Z' })] },
      cursor: { 'user-1': '2026-08-18T00:00:00.000Z' },
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.unreadCount).toBe(0);
  });

  it('R4.2: items tied on occurredAt render in deterministic (occurredAt desc, kind, id) order', async () => {
    // Two artifacts with the SAME occurredAt but different ids -- kind is
    // equal, so id ascending decides the order.
    const service = buildService({
      artifacts: {
        'user-1': [
          makeArtifact({ id: 'z-artifact', createdAt: '2026-08-18T00:00:00.000Z' }),
          makeArtifact({ id: 'a-artifact', createdAt: '2026-08-18T00:00:00.000Z' }),
        ],
      },
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.items.map((i) => i.id)).toEqual(['a-artifact', 'z-artifact']);
  });

  it('R4.2b: items tied on occurredAt across DIFFERENT kinds order by kind ascending', async () => {
    const service = buildService({
      artifacts: { 'user-1': [makeArtifact({ id: 'a1', createdAt: '2026-08-18T00:00:00.000Z' })] },
      jobs: [
        makeWorktreeDeleteJob({
          id: 'job-1',
          requestUsername: 'alice',
          completed_at: new Date('2026-08-18T00:00:00.000Z').getTime(),
        }),
      ],
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.items).toHaveLength(2);
    // 'artifact-created' < 'worktree-deletion-finished' lexicographically.
    expect(result.items.map((i) => i.kind)).toEqual(['artifact-created', 'worktree-deletion-finished']);
  });

  it('R4.3: mixed-source timestamp normalization -- ISO artifact and epoch-ms job merge into one correctly-sorted list', async () => {
    const service = buildService({
      artifacts: { 'user-1': [makeArtifact({ id: 'newer-artifact', createdAt: '2026-08-18T12:00:00.000Z' })] },
      jobs: [
        makeWorktreeDeleteJob({
          id: 'older-job',
          requestUsername: 'alice',
          completed_at: new Date('2026-08-18T06:00:00.000Z').getTime(),
        }),
      ],
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.items.map((i) => i.id)).toEqual(['newer-artifact', 'older-job']);
    const jobItem = result.items.find((i) => i.id === 'older-job') as NotificationItem;
    expect(jobItem.occurredAt).toBe('2026-08-18T06:00:00.000Z');
  });

  it('R4.4a: a worktree:delete job with unparseable JSON payload is silently skipped, not thrown', async () => {
    const badJob: JobRecord = {
      id: 'bad-job',
      type: JOB_TYPES.WORKTREE_DELETE,
      payload: 'not json',
      status: JOB_STATUS.COMPLETED,
      priority: 0,
      attempts: 1,
      max_attempts: 5,
      next_retry_at: 0,
      last_error: null,
      created_at: 1000,
      started_at: 1000,
      completed_at: 2000,
    };
    const service = buildService({ jobs: [badJob] });
    const result = await service.getFeed(IDENTITY);
    expect(result.items).toEqual([]);
    expect(result.unreadCount).toBe(0);
  });

  it('R4.4b: a worktree:delete job whose valid JSON payload does not narrow to WorktreeDeletePayload is silently skipped, not thrown', async () => {
    const badShapeJob: JobRecord = {
      id: 'bad-shape-job',
      type: JOB_TYPES.WORKTREE_DELETE,
      payload: JSON.stringify({ jobId: 'bad-shape-job', repoId: 'repo-1' }), // missing worktreePath/force/requestUsername
      status: JOB_STATUS.COMPLETED,
      priority: 0,
      attempts: 1,
      max_attempts: 5,
      next_retry_at: 0,
      last_error: null,
      created_at: 1000,
      started_at: 1000,
      completed_at: 2000,
    };
    const service = buildService({ jobs: [badShapeJob] });
    const result = await service.getFeed(IDENTITY);
    expect(result.items).toEqual([]);
  });

  it('R4.5: non-terminal (pending/processing) worktree:delete jobs are absent from the feed', async () => {
    const service = buildService({
      jobs: [
        makeWorktreeDeleteJob({ id: 'pending-job', requestUsername: 'alice', status: JOB_STATUS.PENDING }),
        makeWorktreeDeleteJob({ id: 'processing-job', requestUsername: 'alice', status: JOB_STATUS.PROCESSING }),
      ],
    });
    const result = await service.getFeed(IDENTITY);
    expect(result.items).toEqual([]);
  });

  it('R4.6 / R4.7: cap is applied AFTER merge+sort, and unreadCount is computed PRE-cap', async () => {
    const artifacts: Artifact[] = Array.from({ length: 30 }, (_, i) =>
      makeArtifact({ id: `artifact-${i}`, createdAt: new Date(2026, 7, 1, 0, i).toISOString() })
    );
    const jobs: JobRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeWorktreeDeleteJob({
        id: `job-${i}`,
        requestUsername: 'alice',
        completed_at: new Date(2026, 7, 2, 0, i).getTime(),
      })
    );
    const service = buildService({ artifacts: { 'user-1': artifacts }, jobs });
    const result = await service.getFeed(IDENTITY);

    // 60 total unread items across both sources, but items is capped at 50.
    expect(result.items.length).toBe(50);
    expect(result.unreadCount).toBe(60);
    expect(result.unreadCount).toBeGreaterThan(result.items.length);

    // The 50 returned are the 50 newest: all 30 jobs (created on 2026-08-02,
    // newer) come before any artifact (created on 2026-08-01, older).
    const jobItems = result.items.filter((i) => i.kind === 'worktree-deletion-finished');
    const artifactItems = result.items.filter((i) => i.kind === 'artifact-created');
    expect(jobItems).toHaveLength(30);
    expect(artifactItems).toHaveLength(20);
  });

  describe('R3: identity filtering', () => {
    it('excludes an artifact owned by a different userId', async () => {
      const service = buildService({
        artifacts: { 'someone-else': [makeArtifact({ id: 'not-mine' })] },
      });
      const result = await service.getFeed(IDENTITY);
      expect(result.items).toEqual([]);
    });

    it('excludes a worktree:delete job whose requestUsername belongs to a different user', async () => {
      const service = buildService({
        jobs: [makeWorktreeDeleteJob({ id: 'job-1', requestUsername: 'bob' })],
      });
      const result = await service.getFeed(IDENTITY);
      expect(result.items).toEqual([]);
    });

    it('excludes a worktree:delete job with requestUsername: null (matches nobody)', async () => {
      const service = buildService({
        jobs: [makeWorktreeDeleteJob({ id: 'job-1', requestUsername: null })],
      });
      const result = await service.getFeed(IDENTITY);
      expect(result.items).toEqual([]);
    });

    it('includes a worktree:delete job whose requestUsername matches the caller', async () => {
      const service = buildService({
        jobs: [makeWorktreeDeleteJob({ id: 'job-1', requestUsername: 'alice' })],
      });
      const result = await service.getFeed(IDENTITY);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe('job-1');
    });
  });

  it('R4.8 setup (route-level 400 is tested at the route layer): outcome field reflects completed vs stalled status', async () => {
    const service = buildService({
      jobs: [
        makeWorktreeDeleteJob({ id: 'completed-job', requestUsername: 'alice', status: JOB_STATUS.COMPLETED }),
        makeWorktreeDeleteJob({ id: 'stalled-job', requestUsername: 'alice', status: JOB_STATUS.STALLED }),
      ],
    });
    const result = await service.getFeed(IDENTITY);
    const byId = new Map(result.items.map((i) => [i.id, i]));
    expect(byId.get('completed-job')?.outcome).toBe('completed');
    expect(byId.get('stalled-job')?.outcome).toBe('failed');
  });
});
