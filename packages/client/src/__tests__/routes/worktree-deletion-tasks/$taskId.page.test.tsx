import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    type: 'worktree:delete',
    payload: {
      jobId: 'job-1',
      repoId: 'repo-1',
      worktreePath: '/path/to/my-feature',
      force: false,
      requestUsername: null,
    },
    status: 'completed',
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
    mockFetch.mockResolvedValue(jsonResponse(makeJob({ status: 'completed' })));

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
      jsonResponse(makeJob({ status: 'stalled', lastError: 'Uncommitted changes in worktree' }))
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
    mockFetch.mockResolvedValue(jsonResponse(makeJob({ status: 'processing' })));

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

    resolveFetch(jsonResponse(makeJob({ status: 'completed' })));
    await waitFor(() => {
      expect(screen.getByText('Worktree Deleted')).toBeTruthy();
    });
  });
});
