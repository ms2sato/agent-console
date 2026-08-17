import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JOB_STATUS, JOB_TYPES } from '@agent-console/shared';
import type { Job } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { WorktreeDeletionTasksContext } from '../../../contexts/root-contexts';
import { useWorktreeDeletionTasks } from '../../../hooks/useWorktreeDeletionTasks';
import { WorktreeDeletionTaskPageContent } from '../../../routes/worktree-deletion-tasks/$taskId';
import type { UseWorktreeDeletionTasksReturn } from '../../../hooks/useWorktreeDeletionTasks';

/**
 * Rendering tests for `WorktreeDeletionTaskPageContent` (Issue #1327 S3).
 * Mocks `fetch` at the network boundary (`fetchJob` goes through the Hono
 * RPC client) per testing.md -- not `lib/api`, which other files import
 * for real.
 *
 * These tests import and render the page's actual `GET /api/jobs/:id`
 * recovery-path logic. `WorktreeDeletionTaskPageContent` is exported
 * specifically so tests can supply `taskId` directly instead of needing a
 * matching TanStack Router route tree just to reach `Route.useParams()`
 * (mirrors the `JobDetailPending`/`JobDetailError` exported-subcomponent
 * pattern already used for `routes/jobs/$jobId/index.tsx`).
 */

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, options: { status?: number; ok?: boolean } = {}) {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function createMockDeletionContext(
  overrides?: Partial<UseWorktreeDeletionTasksReturn>
): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JOB_TYPES.WORKTREE_DELETE,
    payload: {
      jobId: 'job-1',
      repoId: 'repo-1',
      worktreePath: '/path/to/my-feature',
      force: false,
      requestUsername: null,
    },
    status: JOB_STATUS.COMPLETED,
    priority: 0,
    attempts: 1,
    maxAttempts: 1,
    nextRetryAt: 0,
    lastError: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

async function renderPage(taskId: string, ctx?: UseWorktreeDeletionTasksReturn) {
  const context = ctx ?? createMockDeletionContext();
  return renderWithRouter(
    <WorktreeDeletionTasksContext.Provider value={context}>
      <WorktreeDeletionTaskPageContent taskId={taskId} />
    </WorktreeDeletionTasksContext.Provider>
  );
}

describe('WorktreeDeletionTaskPageContent', () => {
  // T1 -- bug-polarity (the reported #1327 defect). Must fail against
  // today's main, which renders the "Task Not Found ... or has been
  // completed" card whenever no in-memory task exists, regardless of
  // whether the deletion actually succeeded.
  it('T1 (bug-polarity): renders the completed terminal state for a completed job with no in-memory task, not the not-found card', async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeJob({ status: JOB_STATUS.COMPLETED })));

    await renderPage('job-1');

    await waitFor(() => {
      expect(screen.getByText('Worktree Deleted')).toBeTruthy();
    });
    expect(screen.getByText('Deleted successfully')).toBeTruthy();
    expect(screen.queryByText('Task Not Found')).toBeNull();
    expect(screen.queryByText(/or has been completed/i)).toBeNull();
  });

  it('T2 (new-mechanism contract): a stalled job renders the failed state with job.lastError as the error text', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(makeJob({ status: JOB_STATUS.STALLED, lastError: 'Uncommitted changes in worktree' }))
    );

    await renderPage('job-2');

    await waitFor(() => {
      expect(screen.getByText('Worktree Deletion Failed')).toBeTruthy();
    });
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Uncommitted changes in worktree')).toBeTruthy();
    // Force Delete is only offered once the deletion is actually known to have failed.
    expect(screen.getByRole('button', { name: 'Force Delete' })).toBeTruthy();
  });

  it('T3 (new-mechanism contract): a pending/processing job with no in-memory task renders the deleting state', async () => {
    mockFetch.mockResolvedValue(jsonResponse(makeJob({ status: JOB_STATUS.PROCESSING })));

    await renderPage('job-3');

    await waitFor(() => {
      expect(screen.getByText('Deleting worktree...')).toBeTruthy();
    });
    expect(screen.getByText('Delete Worktree')).toBeTruthy();
  });

  it('T3 (invariant-preservation): an in-memory task still renders live via handleWorktreeDeletionCompleted, in-memory context takes precedence over the job fetch', async () => {
    // Uses the REAL useWorktreeDeletionTasks() hook (not a mock) so that
    // handleWorktreeDeletionCompleted actually mutates state and re-renders
    // -- a mocked context can't demonstrate the live-broadcast path.
    // This would fail against a plausible wrong implementation that always
    // consulted the job fetch instead of preferring the in-memory context.
    function LiveTaskHarness({ taskId }: { taskId: string }) {
      const ctx = useWorktreeDeletionTasks();
      return (
        <WorktreeDeletionTasksContext.Provider value={ctx}>
          <button
            onClick={() =>
              ctx.addTask({
                id: taskId,
                sessionId: 'session-live',
                sessionTitle: 'Live Session',
                repositoryId: 'repo-1',
                worktreePath: '/path/to/live',
              })
            }
          >
            seed-task
          </button>
          <button onClick={() => ctx.handleWorktreeDeletionCompleted({ taskId, sessionIds: [] })}>
            simulate-broadcast-complete
          </button>
          <WorktreeDeletionTaskPageContent taskId={taskId} />
        </WorktreeDeletionTasksContext.Provider>
      );
    }

    // The initial mount (no in-memory task yet) triggers the recovery-path
    // fetch; give it an unrelated 404 so it settles without racing the
    // seeded in-memory task below.
    mockFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));

    const user = userEvent.setup();
    await renderWithRouter(<LiveTaskHarness taskId="task-live" />);

    await user.click(screen.getByText('seed-task'));

    await waitFor(() => {
      expect(screen.getByText('Deleting worktree...')).toBeTruthy();
    });

    await user.click(screen.getByText('simulate-broadcast-complete'));

    await waitFor(() => {
      expect(screen.getByText('Worktree Deleted')).toBeTruthy();
    });
  });

  it('T5: an unknown id (job fetch 404s) renders the honest no-record wording, never the misleading "has been completed" phrasing', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Job not found' }, { ok: false, status: 404 }));

    await renderPage('unknown-id');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'No Record of This Task' })).toBeTruthy();
    });
    expect(
      screen.getByText('No record of this task. It may be an old or invalid link.')
    ).toBeTruthy();
    expect(screen.queryByText(/has been completed/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toBeTruthy();
  });

  it('shows a loading state while the recovery fetch is in flight, instead of flashing the not-found card first', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    mockFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; })
    );

    await renderPage('job-loading');

    expect(screen.getByText('Checking task status...')).toBeTruthy();
    expect(screen.queryByText('No Record of This Task')).toBeNull();

    resolveFetch(jsonResponse(makeJob({ status: JOB_STATUS.COMPLETED })));
    await waitFor(() => {
      expect(screen.getByText('Worktree Deleted')).toBeTruthy();
    });
  });

  // M1 (bug-polarity): a plain missed completion broadcast -- not a
  // reconnect, the WS stays connected the whole time -- must not leave the
  // page stuck showing "deleting" forever. Must fail against the
  // pre-`refetchInterval` code, which fetches the recovery-path job exactly
  // once and therefore never observes a later status change.
  //
  // This test uses real timers rather than faked ones: this codebase has no
  // established fake-timer harness for bun:test, and the assertions below
  // exercise the actual `refetchInterval` timer firing (or not firing),
  // which faking would only simulate. `it`'s numeric third argument raises
  // the per-test timeout past the wall-clock waits below (see the sibling
  // `process-tree.test.ts` / `routes-history.test.ts` pattern for the same
  // `it(name, fn, timeoutMs)` shape).
  it(
    'M1: polls the recovery-path job every 5s while non-terminal, and stops once it reaches a terminal status',
    async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount += 1;
        // First fetch observes the job still in progress; every fetch after
        // that observes it completed -- simulates the completion happening
        // between the first fetch and the next poll tick.
        const status = callCount === 1 ? JOB_STATUS.PROCESSING : JOB_STATUS.COMPLETED;
        return Promise.resolve(jsonResponse(makeJob({ status })));
      });

      await renderPage('job-polling');

      await waitFor(() => {
        expect(screen.getByText('Deleting worktree...')).toBeTruthy();
      });
      expect(callCount).toBe(1);

      // Nothing else re-renders this component (no in-memory task, no WS
      // broadcast) -- reaching the completed view is only possible if the
      // `refetchInterval` timer actually fires a second fetch on its own.
      await waitFor(
        () => {
          expect(screen.getByText('Worktree Deleted')).toBeTruthy();
        },
        { timeout: 7000 }
      );
      expect(callCount).toBe(2);

      // The job is now terminal (`completed`) -- confirm polling actually
      // stopped by waiting past another full interval window and checking
      // no third fetch happened.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      expect(callCount).toBe(2);
    },
    15000
  );
});
