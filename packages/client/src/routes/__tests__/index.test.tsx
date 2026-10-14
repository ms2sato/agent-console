/**
 * Tests for the Dashboard page (routes/index.tsx).
 *
 * Verifies the "Add Repository" trigger visibility / behavior across the two
 * branches of the repository list (empty vs >=1 repos). The fix for issue #779
 * adds a header trigger that is hidden in the empty state and visible whenever
 * at least one repository is registered.
 *
 * `useAppWsEvent` is replaced per-test via `spyOn` (NOT `mock.module`, which is
 * process-global in bun:test and would leak into other test files) to avoid
 * setting up a real WebSocket subscription during render. `fetch` is mocked to
 * provide the repositories list (consumed via TanStack Query). All other
 * dependencies are either real (router via `renderWithRouter`) or
 * context-injected (root layout providers).
 */
import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';

import { DashboardPage, SessionCard, WorktreeRow, SessionStopResultBanner } from '../index';
import { SessionDataContext, WorktreeDeletionTasksContext, WorktreeCreationTasksContext, SessionStopTasksContext } from '../../contexts/root-contexts';
import { renderWithRouter } from '../../test/renderWithRouter';
import { waitForAbsent } from '../../test/waitForAbsent';
import type { Repository, Session } from '@agent-console/shared';
import type { SessionStopTask } from '../../hooks/useSessionStopTasks';
import type { UseWorktreeDeletionTasksReturn } from '../../hooks/useWorktreeDeletionTasks';
import type { UseWorktreeCreationTasksReturn } from '../../hooks/useWorktreeCreationTasks';
import { useSessionStopTasks, type UseSessionStopTasksReturn } from '../../hooks/useSessionStopTasks';
import * as useAppWsModule from '../../hooks/useAppWs';
import * as capabilitiesModule from '../../lib/capabilities';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../lib/auth';
import { completeWireBody } from '../../test/wire-fixtures';

// --- Module-level spies (test-instance scoped via mockRestore in afterEach) ---
//
// We use spyOn rather than mock.module() because mock.module() is process-global
// in bun:test and leaks into other test files (e.g., useAppWs.test.ts) that share
// the same process, breaking unrelated tests. spyOn is restorable per-test.
//
// - useAppWsEvent: Dashboard subscribes for activity / repo events; we replace it
//   with a no-op so no real WebSocket subscription is attempted during render.
// - useAppWsState: not currently called by DashboardPage but mirrored from the
//   original module mock for parity.
// - hasVSCode: reads from a module-level capability cache populated at app boot;
//   force a deterministic value during tests.

let useAppWsEventSpy: ReturnType<typeof spyOn>;
let useAppWsStateSpy: ReturnType<typeof spyOn>;
let hasVSCodeSpy: ReturnType<typeof spyOn>;

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch;

interface FetchResponses {
  repositories: Repository[];
  /** Map of repositoryId -> worktrees array */
  worktreesByRepoId: Record<string, unknown[]>;
  /** Map of repositoryId -> pathStatus carried by the worktree listing; absent means 'ok'. */
  pathStatusByRepoId?: Record<string, 'ok' | 'missing' | 'inaccessible'>;
  /**
   * Optional override for DELETE /api/repositories/:id responses.
   * Keyed by repositoryId. When absent, the DELETE handler returns 204 No Content
   * AND removes the repository from `repositories` so a refetch reflects the deletion.
   */
  deleteRepositoryResponses?: Record<string, { status: number; body?: unknown }>;
  /**
   * Recorded DELETE calls so tests can assert which repository id was sent.
   */
  deleteRepositoryCalls?: string[];
  /**
   * Recorded DELETE bodies so tests can assert the JSON payload (or its absence)
   * that the client sent. Each entry is the parsed JSON body, or `undefined`
   * when the DELETE was issued without a body. Indices align with
   * `deleteRepositoryCalls`.
   */
  deleteRepositoryBodies?: unknown[];
  /**
   * Recorded DELETE /api/sessions/:id calls (Issue #1247 SessionCard tests).
   */
  deleteSessionCalls?: string[];
  /**
   * When set, DELETE /api/sessions/:id rejects with this message instead of
   * resolving 204 (Issue #1247 SessionCard error-surfacing tests).
   */
  deleteSessionError?: string;
}

let fetchResponses: FetchResponses = {
  repositories: [],
  worktreesByRepoId: {},
};

const resumeSessionCalls: string[] = [];

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  // GET /api/repositories
  if (method === 'GET' && /\/api\/repositories(\?|$)/.test(url)) {
    return new Response(JSON.stringify(completeWireBody({ repositories: fetchResponses.repositories })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/repositories/:id/worktrees
  if (method === 'GET' && /\/api\/repositories\/[^/]+\/worktrees$/.test(url)) {
    const match = url.match(/\/api\/repositories\/([^/]+)\/worktrees/);
    const repoId = match?.[1] ?? '';
    const worktrees = fetchResponses.worktreesByRepoId[repoId] ?? [];
    const pathStatus = fetchResponses.pathStatusByRepoId?.[repoId] ?? 'ok';
    return new Response(JSON.stringify({ worktrees, pathStatus }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/repositories/:id  (unregister flow)
  if (method === 'DELETE' && /\/api\/repositories\/[^/]+$/.test(url)) {
    const match = url.match(/\/api\/repositories\/([^/]+)$/);
    const repoId = match?.[1] ?? '';
    fetchResponses.deleteRepositoryCalls?.push(repoId);
    if (fetchResponses.deleteRepositoryBodies) {
      const rawBody = init?.body;
      let parsed: unknown = undefined;
      if (typeof rawBody === 'string' && rawBody.length > 0) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }
      fetchResponses.deleteRepositoryBodies.push(parsed);
    }
    const override = fetchResponses.deleteRepositoryResponses?.[repoId];
    if (override) {
      const body = override.body === undefined ? null : override.body;
      return new Response(body === null ? null : JSON.stringify(body), {
        status: override.status,
        headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      });
    }
    // Default: success path — remove the repo from the next GET response so refetch reflects deletion.
    fetchResponses.repositories = fetchResponses.repositories.filter((r) => r.id !== repoId);
    return new Response(null, { status: 204 });
  }

  // DELETE /api/sessions/:id  (Stop Session flow, Issue #1247)
  if (method === 'DELETE' && /\/api\/sessions\/[^/]+$/.test(url)) {
    const match = url.match(/\/api\/sessions\/([^/]+)$/);
    const sessionId = match?.[1] ?? '';
    fetchResponses.deleteSessionCalls?.push(sessionId);
    if (fetchResponses.deleteSessionError) {
      return Promise.reject(new Error(fetchResponses.deleteSessionError));
    }
    return new Response(null, { status: 204 });
  }

  // POST /api/sessions/:id/resume  (Resume affordances)
  if (method === 'POST' && /\/api\/sessions\/[^/]+\/resume$/.test(url)) {
    const sessionId = url.match(/\/api\/sessions\/([^/]+)\/resume$/)?.[1] ?? '';
    resumeSessionCalls.push(sessionId);
    return new Response(JSON.stringify({
      session: {
        id: sessionId,
        type: 'quick',
        locationPath: `/tmp/${sessionId}`,
        status: 'active',
        activationState: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        workers: [],
        isShared: false,
        recoveryState: 'healthy',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Default: empty success response (covers branches lookups, etc.)
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// --- Test data factories ---

function createTestRepository(overrides?: Partial<Repository>): Repository {
  return {
    id: 'repo-1',
    name: 'my-repo',
    path: '/test/repos/my-repo',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Repository;
}

function createMockDeletionContext(): UseWorktreeDeletionTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    handleWorktreeDeletionCompleted: mock(() => {}),
    handleWorktreeDeletionFailed: mock(() => {}),
  };
}

function createMockCreationContext(): UseWorktreeCreationTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => {}),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    handleWorktreeCreationCompleted: mock(() => {}),
    handleWorktreeCreationFailed: mock(() => {}),
  };
}

function createMockSessionStopTasks(overrides: Partial<UseSessionStopTasksReturn> = {}): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
    markAsSucceeded: mock(() => {}),
    markAsPending: mock(() => {}),
    ...overrides,
  };
}

// Provider that exercises the REAL useSessionStopTasks hook (not a mock), so
// production task-state transitions (addTask / markAsFailed / getTask) flow
// through to consumers and re-render them as they would in the app.
function RealSessionStopTasksProvider({ children }: { children: React.ReactNode }) {
  const sessionStopTasks = useSessionStopTasks();
  return (
    <SessionStopTasksContext.Provider value={sessionStopTasks}>
      {children}
    </SessionStopTasksContext.Provider>
  );
}

// --- Render helper ---

async function renderDashboard(
  repositories: Repository[],
  options?: {
    deleteRepositoryResponses?: Record<string, { status: number; body?: unknown }>;
    deleteRepositoryCalls?: string[];
    deleteRepositoryBodies?: unknown[];
    sessionStopTasks?: UseSessionStopTasksReturn;
    sessions?: Session[];
    deleteSessionCalls?: string[];
    deleteSessionError?: string;
    pathStatusByRepoId?: Record<string, 'ok' | 'missing' | 'inaccessible'>;
  }
) {
  fetchResponses = {
    repositories: [...repositories],
    worktreesByRepoId: Object.fromEntries(repositories.map((r) => [r.id, []])),
    pathStatusByRepoId: options?.pathStatusByRepoId,
    deleteRepositoryResponses: options?.deleteRepositoryResponses,
    deleteRepositoryCalls: options?.deleteRepositoryCalls,
    deleteRepositoryBodies: options?.deleteRepositoryBodies,
    deleteSessionCalls: options?.deleteSessionCalls,
    deleteSessionError: options?.deleteSessionError,
  };

  const sessionDataValue = {
    sessions: options?.sessions ?? [],
    wsInitialized: true,
    workerActivityStates: {},
  };

  return renderWithRouter(
    <SessionDataContext.Provider value={sessionDataValue}>
      <WorktreeCreationTasksContext.Provider value={createMockCreationContext()}>
        <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
          <SessionStopTasksContext.Provider value={options?.sessionStopTasks ?? createMockSessionStopTasks()}>
            <DashboardPage />
          </SessionStopTasksContext.Provider>
        </WorktreeDeletionTasksContext.Provider>
      </WorktreeCreationTasksContext.Provider>
    </SessionDataContext.Provider>
  );
}

// --- Tests ---

describe('DashboardPage / Add Repository trigger', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
    // useAppWsState<T>(selector) is generic; the cast on the inner function returns
    // `false` regardless of the requested selector type. DashboardPage does not call
    // useAppWsState directly today, so the value is never observed by production code.
    useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(
      <T,>() => false as T
    );
    hasVSCodeSpy = spyOn(capabilitiesModule, 'hasVSCode').mockImplementation(() => false);
  });

  afterEach(() => {
    cleanup();
    useAppWsEventSpy.mockRestore();
    useAppWsStateSpy.mockRestore();
    hasVSCodeSpy.mockRestore();
  });

  describe('empty state (0 repositories)', () => {
    it('shows the empty-state "Add your first repository" button and hides the header trigger', async () => {
      await renderDashboard([]);

      await waitFor(() => {
        expect(screen.getByText('Add your first repository')).toBeTruthy();
      });
      // Header trigger must NOT appear when no repositories are registered.
      expect(screen.queryByRole('button', { name: 'Add Repository' })).toBeNull();
    });

    it('opens the AddRepositoryForm when the empty-state button is clicked', async () => {
      await renderDashboard([]);

      await waitFor(() => {
        expect(screen.getByText('Add your first repository')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Add your first repository'));

      // Form heading appears once the form is mounted.
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Add Repository', level: 2 })).toBeTruthy();
      });
    });
  });

  describe('non-empty state (>=1 repositories)', () => {
    it('shows the header "Add Repository" button and hides the empty-state CTA', async () => {
      await renderDashboard([createTestRepository()]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add Repository' })).toBeTruthy();
      });
      expect(screen.queryByText('Add your first repository')).toBeNull();
    });

    it('opens the AddRepositoryForm when the header button is clicked', async () => {
      await renderDashboard([createTestRepository()]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add Repository' })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Add Repository' }));

      // Form heading appears (form is rendered above the repository list).
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Add Repository', level: 2 })).toBeTruthy();
      });
    });

    it('keeps the form open and does not error when the header trigger is clicked while the form is already open', async () => {
      await renderDashboard([createTestRepository()]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add Repository' })).toBeTruthy();
      });

      const headerButton = screen.getByRole('button', { name: 'Add Repository' });
      fireEvent.click(headerButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Add Repository', level: 2 })).toBeTruthy();
      });

      // Clicking the still-visible header button again is a no-op (setShowAddRepo(true) when already true).
      fireEvent.click(headerButton);

      // Only one form instance should be present (single heading).
      expect(screen.getAllByRole('heading', { name: 'Add Repository', level: 2 })).toHaveLength(1);
    });

    it('closes the form via Cancel and keeps the header trigger visible afterwards', async () => {
      await renderDashboard([createTestRepository()]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add Repository' })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Add Repository' }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Add Repository', level: 2 })).toBeTruthy();
      });

      // Cancel the form (Cancel button is rendered inside AddRepositoryForm).
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      // Form heading is gone, header trigger remains.
      await waitForAbsent(() => screen.queryByRole('heading', { name: 'Add Repository', level: 2 }));
      expect(screen.getByRole('button', { name: 'Add Repository' })).toBeTruthy();
    });
  });
});

/**
 * Tests for Issue #871 — Unregister Repository flow.
 *
 * The original implementation was fire-and-forget: clicking "Unregister" in the
 * ConfirmDialog called `unregisterMutation.mutate(...)` and immediately closed
 * the dialog, so a failing DELETE silently left the repository in the list with
 * no operator-visible error. The fix awaits `mutateAsync` and surfaces failures
 * through a dedicated ErrorDialog. These tests pin both the success refetch
 * behavior and the error-surfacing behavior.
 */
describe('DashboardPage / repository path status notice', () => {
  let useAppWsEventSpy: ReturnType<typeof spyOn>;
  let useAppWsStateSpy: ReturnType<typeof spyOn>;
  let hasVSCodeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFetch.mockClear();
    useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => {});
    useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(<T,>() => false as T);
    hasVSCodeSpy = spyOn(capabilitiesModule, 'hasVSCode').mockImplementation(() => false);
  });

  afterEach(() => {
    cleanup();
    useAppWsEventSpy.mockRestore();
    useAppWsStateSpy.mockRestore();
    hasVSCodeSpy.mockRestore();
  });

  it('shows the "path not found" notice naming the path instead of "No worktrees" when the listing says missing', async () => {
    await renderDashboard([createTestRepository()], { pathStatusByRepoId: { 'repo-1': 'missing' } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        'Repository path not found: /test/repos/my-repo. The directory was moved or deleted; remove this entry and register it again at the new location.',
      );
    });
    expect(screen.queryByText('No worktrees')).toBeNull();
  });

  it('shows the "cannot be read" notice naming the path when the listing says inaccessible', async () => {
    await renderDashboard([createTestRepository()], { pathStatusByRepoId: { 'repo-1': 'inaccessible' } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        "Repository path cannot be read by the server: /test/repos/my-repo. Check the directory's permissions for the server's OS user; worktrees cannot be listed until then.",
      );
    });
    expect(screen.queryByText('No worktrees')).toBeNull();
  });

  it('keeps "No worktrees" and no notice for a healthy repository with zero worktrees', async () => {
    await renderDashboard([createTestRepository()]);

    await waitFor(() => {
      expect(screen.getByText('No worktrees')).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DashboardPage / Unregister Repository', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
    useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(
      <T,>() => false as T
    );
    hasVSCodeSpy = spyOn(capabilitiesModule, 'hasVSCode').mockImplementation(() => false);
  });

  afterEach(() => {
    cleanup();
    useAppWsEventSpy.mockRestore();
    useAppWsStateSpy.mockRestore();
    hasVSCodeSpy.mockRestore();
  });

  it('removes the repository, closes the confirm dialog, and refetches the list on successful DELETE', async () => {
    const deleteCalls: string[] = [];
    const { queryClient } = await renderDashboard([createTestRepository()], {
      deleteRepositoryCalls: deleteCalls,
    });

    // Repository card rendered for repo-1
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    // Open the ConfirmDialog via the card's "Remove" button.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // ConfirmDialog appears with the "Unregister Repository" title.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    // Click the confirm button labelled "Unregister".
    fireEvent.click(screen.getByRole('button', { name: 'Unregister' }));

    // DELETE was invoked against the correct repository id.
    await waitFor(() => {
      expect(deleteCalls).toEqual(['repo-1']);
    });

    // Confirm dialog is dismissed after success.
    await waitForAbsent(() => screen.queryByRole('heading', { name: 'Unregister Repository' }));

    // Trigger a refetch (production code calls invalidateQueries; force the refetch deterministically here).
    await queryClient.refetchQueries({ queryKey: ['repositories'] });

    // Repository card is gone — the DELETE handler removed it from the response set, so the refetch reflects the deletion.
    await waitForAbsent(() => screen.queryByRole('heading', { name: 'my-repo', level: 2 }));

    // The error dialog is NOT shown on the success path.
    expect(screen.queryByRole('heading', { name: 'Unregister Failed' })).toBeNull();
  });

  it('surfaces the server error message in an ErrorDialog and keeps the repository in the list when DELETE fails', async () => {
    const deleteCalls: string[] = [];
    await renderDashboard([createTestRepository()], {
      deleteRepositoryResponses: {
        'repo-1': { status: 500, body: { error: 'permission denied' } },
      },
      deleteRepositoryCalls: deleteCalls,
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    // Open the ConfirmDialog.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    // Confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Unregister' }));

    // DELETE invoked.
    await waitFor(() => {
      expect(deleteCalls).toEqual(['repo-1']);
    });

    // Confirm dialog is dismissed even though the request failed (operator dismisses error dialog separately).
    await waitForAbsent(() => screen.queryByRole('heading', { name: 'Unregister Repository' }));

    // ErrorDialog appears with the title and server-provided message.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Failed' })).toBeTruthy();
    });
    expect(screen.getByText('permission denied')).toBeTruthy();

    // The repository remains in the list (no silent removal on error).
    // Radix's open AlertDialog marks the page background `aria-hidden`, so we
    // include hidden elements when querying for the still-mounted repo heading.
    expect(screen.getByRole('heading', { name: 'my-repo', level: 2, hidden: true })).toBeTruthy();
  });
});

/**
 * Tests for Issue #905 — source-repo cleanup opt-in checkbox on the Unregister
 * Repository dialog. The checkbox is only meaningful (and only rendered) when
 * the repository was registered via "Clone from URL" — i.e. when
 * `clonedSourceRepoPath` is non-null. External-path repositories MUST NOT show
 * the checkbox. When checked, the client sends `{ removeSourceRepo: true }`
 * in the DELETE body; when unchecked, no body is sent.
 */
describe('DashboardPage / Unregister Repository — source-repo cleanup checkbox', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
    useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(
      <T,>() => false as T
    );
    hasVSCodeSpy = spyOn(capabilitiesModule, 'hasVSCode').mockImplementation(() => false);
  });

  afterEach(() => {
    cleanup();
    useAppWsEventSpy.mockRestore();
    useAppWsStateSpy.mockRestore();
    hasVSCodeSpy.mockRestore();
  });

  it('does NOT render the checkbox when clonedSourceRepoPath is null', async () => {
    await renderDashboard([
      createTestRepository({ clonedSourceRepoPath: null }),
    ]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders the checkbox with the path label when clonedSourceRepoPath is non-null', async () => {
    const clonedPath = '/test/source-repos/my-repo';
    await renderDashboard([
      createTestRepository({ clonedSourceRepoPath: clonedPath }),
    ]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // Path appears inside the checkbox label.
    expect(screen.getByText(clonedPath)).toBeTruthy();
  });

  it('passes removeSourceRepo: true in the DELETE body when checked and confirmed', async () => {
    const deleteCalls: string[] = [];
    const deleteBodies: unknown[] = [];
    await renderDashboard(
      [
        createTestRepository({
          clonedSourceRepoPath: '/test/source-repos/my-repo',
        }),
      ],
      {
        deleteRepositoryCalls: deleteCalls,
        deleteRepositoryBodies: deleteBodies,
      }
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Unregister' }));

    await waitFor(() => {
      expect(deleteCalls).toEqual(['repo-1']);
    });

    expect(deleteBodies).toEqual([{ removeSourceRepo: true }]);
  });

  it('omits the body when the checkbox stays unchecked and confirmed', async () => {
    const deleteCalls: string[] = [];
    const deleteBodies: unknown[] = [];
    await renderDashboard(
      [
        createTestRepository({
          clonedSourceRepoPath: '/test/source-repos/my-repo',
        }),
      ],
      {
        deleteRepositoryCalls: deleteCalls,
        deleteRepositoryBodies: deleteBodies,
      }
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });

    // Don't click the checkbox — leave it unchecked.
    fireEvent.click(screen.getByRole('button', { name: 'Unregister' }));

    await waitFor(() => {
      expect(deleteCalls).toEqual(['repo-1']);
    });

    expect(deleteBodies).toEqual([undefined]);
  });

  it('resets the checkbox state to unchecked after the dialog is dismissed and reopened', async () => {
    await renderDashboard([
      createTestRepository({
        clonedSourceRepoPath: '/test/source-repos/my-repo',
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 2 })).toBeTruthy();
    });

    // First open: check the box.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    // Cancel the dialog (Radix AlertDialogCancel is rendered as the "Cancel" button).
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitForAbsent(() => screen.queryByRole('heading', { name: 'Unregister Repository' }));

    // Re-open: checkbox state should be reset to unchecked.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});

/**
 * Tests for Issue #1247 -- Stop Session no longer holds a modal open while the
 * server round-trip is in flight, for the Dashboard's quick-session card. The
 * "no optimistic update" boundary (the session list only changes via
 * sessions-sync / session-deleted) is covered by useSessionSideEffects.test.ts;
 * these tests only pin SessionCard's own confirm-handler behavior.
 */
describe('SessionCard / Issue #1247 scoped pending state', () => {
  function createMockQuickSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'quick-1',
      type: 'quick',
      title: 'My Quick Session',
      locationPath: '/tmp/quick-1',
      status: 'active',
      activationState: 'running',
      createdAt: new Date().toISOString(),
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      ...overrides,
    } as Session;
  }

  beforeEach(() => {
    mockFetch.mockClear();
    fetchResponses = {
      repositories: [],
      worktreesByRepoId: {},
      deleteSessionCalls: [],
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('closes the ConfirmDialog synchronously on confirm, without awaiting deleteSession', async () => {
    const session = createMockQuickSession();
    await renderWithRouter(
      <SessionStopTasksContext.Provider value={createMockSessionStopTasks()}>
        <SessionCard session={session} />
      </SessionStopTasksContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmButton = screen.getAllByRole('button', { name: 'Stop' })
      .find((btn) => dialog.contains(btn));
    expect(confirmButton).toBeTruthy();

    fireEvent.click(confirmButton!);

    // Assert synchronously, before awaiting/flushing the deleteSession fetch call.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await waitFor(() => {
      expect(fetchResponses.deleteSessionCalls).toEqual(['quick-1']);
    });
  });

  it('disables the trigger button once a task exists, so a second click cannot fire a second deleteSession call', async () => {
    // Uses the REAL useSessionStopTasks hook so the disabled-control guard is
    // exercised against production task state, not a mock that always reports
    // "no task".
    const session = createMockQuickSession();
    await renderWithRouter(
      <RealSessionStopTasksProvider>
        <SessionCard session={session} />
      </RealSessionStopTasksProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });

    const dialog = screen.getByRole('alertdialog');
    const confirmButton = screen.getAllByRole('button', { name: 'Stop' })
      .find((btn) => dialog.contains(btn));
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(fetchResponses.deleteSessionCalls).toEqual(['quick-1']);
    });

    // The dialog is gone; the card's own trigger button now shows the
    // disabled "Stopping..." indicator instead of "Stop".
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const triggerButton = screen.getByText('Stopping...').closest('button');
    expect(triggerButton).toBeTruthy();
    expect((triggerButton as HTMLButtonElement).disabled).toBe(true);

    // Clicking the disabled trigger does not reopen the confirm dialog, and
    // no second deleteSession call fires.
    fireEvent.click(triggerButton!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchResponses.deleteSessionCalls).toEqual(['quick-1']);
  });

  it('renders the error and Dismiss control when deleteSession rejects, and Dismiss clears it', async () => {
    fetchResponses.deleteSessionError = 'Network error';
    const session = createMockQuickSession();

    // Exercise the REAL useSessionStopTasks hook (not a mock) so markAsFailed's
    // state update actually flows through to `getTask` and re-renders the card.
    await renderWithRouter(
      <RealSessionStopTasksProvider>
        <SessionCard session={session} />
      </RealSessionStopTasksProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });
    const dialog = screen.getByRole('alertdialog');
    const confirmButton = screen.getAllByRole('button', { name: 'Stop' })
      .find((btn) => dialog.contains(btn));
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitForAbsent(() => screen.queryByText('Network error'));
  });
});

/**
 * Tests for Issue #1247 -- the Dashboard's worktree row shows a read-only
 * Stopping.../Pausing... indicator (and error+Dismiss) while a stop/pause task
 * targets its session, without disturbing Open/Pull/Delete. Worktree deletion
 * itself is untouched (out of scope).
 */
describe('WorktreeRow / Issue #1247 stop/pause task indicator', () => {
  function createMockWorktree(overrides: Partial<{ path: string; branch: string; isMain: boolean; repositoryId: string }> = {}) {
    return {
      path: '/tmp/worktree-1',
      branch: 'feature/foo',
      isMain: false,
      repositoryId: 'repo-1',
      ...overrides,
    };
  }

  function createMockWorktreeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'session-1',
      type: 'worktree',
      title: 'My Worktree Session',
      locationPath: '/tmp/worktree-1',
      status: 'active',
      activationState: 'running',
      createdAt: new Date().toISOString(),
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      repositoryId: 'repo-1',
      repositoryName: 'repo',
      worktreeId: 'feature/foo',
      isMainWorktree: false,
      ...overrides,
    } as Session;
  }

  afterEach(() => {
    cleanup();
  });

  it('shows a "Pausing..." indicator and keeps Open enabled while a pause task targets the session', async () => {
    const session = createMockWorktreeSession();
    const sessionStopTasks = createMockSessionStopTasks({
      tasks: [{ sessionId: session.id, action: 'pause', status: 'pending', error: null }],
      getTask: mock((sessionId: string) => (sessionId === session.id ? { sessionId, action: 'pause' as const, status: 'pending' as const, error: null } : undefined)),
    });

    await renderWithRouter(
      <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
        <SessionStopTasksContext.Provider value={sessionStopTasks}>
          <WorktreeRow
            worktree={createMockWorktree()}
            session={session}
            repositoryId="repo-1"
            isPulling={false}
            onPull={() => {}}
          />
        </SessionStopTasksContext.Provider>
      </WorktreeDeletionTasksContext.Provider>
    );

    expect(screen.getByText('Pausing...')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
  });

  it('renders the error and Dismiss control when the task has an error, and Dismiss clears it', async () => {
    // Uses the REAL useSessionStopTasks hook (seeded via useEffect on mount) so
    // the Dismiss click's removeTask call flows through real state and
    // re-renders reactively -- no manual `rerender()` with a differently-shaped
    // tree is needed (rerender() replaces the whole render output, including
    // the router/query-client wrapper renderWithRouter built, and would crash).
    const session = createMockWorktreeSession();

    function WorktreeRowWithSeededError({ session }: { session: Session }) {
      const sessionStopTasks = useSessionStopTasks();
      useEffect(() => {
        sessionStopTasks.addTask({ sessionId: session.id, action: 'stop' });
        sessionStopTasks.markAsFailed(session.id, 'Network error');
        // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once on mount
      }, []);
      return (
        <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
          <SessionStopTasksContext.Provider value={sessionStopTasks}>
            <WorktreeRow
              worktree={createMockWorktree()}
              session={session}
              repositoryId="repo-1"
              isPulling={false}
              onPull={() => {}}
            />
          </SessionStopTasksContext.Provider>
        </WorktreeDeletionTasksContext.Provider>
      );
    }

    await renderWithRouter(<WorktreeRowWithSeededError session={session} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitForAbsent(() => screen.queryByText('Network error'));
  });

  it('does not render an indicator when no task targets the session', async () => {
    const session = createMockWorktreeSession();
    const sessionStopTasks = createMockSessionStopTasks();

    await renderWithRouter(
      <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
        <SessionStopTasksContext.Provider value={sessionStopTasks}>
          <WorktreeRow
            worktree={createMockWorktree()}
            session={session}
            repositoryId="repo-1"
            isPulling={false}
            onPull={() => {}}
          />
        </SessionStopTasksContext.Provider>
      </WorktreeDeletionTasksContext.Provider>
    );

    expect(screen.queryByText('Stopping...')).toBeNull();
    expect(screen.queryByText('Pausing...')).toBeNull();
  });
});

/**
 * Stop/pause success feedback on the dashboard: one result banner at the top
 * (not per card).
 */
describe('Dashboard / stop-pause result feedback', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    resumeSessionCalls.length = 0;
    useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
    useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(<T,>() => false as T);
    hasVSCodeSpy = spyOn(capabilitiesModule, 'hasVSCode').mockImplementation(() => false);
  });

  afterEach(() => {
    cleanup();
    useAppWsEventSpy.mockRestore();
    useAppWsStateSpy.mockRestore();
    hasVSCodeSpy.mockRestore();
  });

  function task(overrides: Partial<SessionStopTask> = {}): SessionStopTask {
    return { sessionId: 'session-1', action: 'pause', sessionTitle: 'My Session', status: 'succeeded', error: null, ...overrides };
  }

  function renderBanner(tasks: SessionStopTask[], removeTask = mock(() => {})) {
    const value = createMockSessionStopTasks({ tasks, removeTask });
    return {
      removeTask,
      rendered: renderWithRouter(
        <SessionStopTasksContext.Provider value={value}>
          <SessionStopResultBanner />
        </SessionStopTasksContext.Provider>
      ),
    };
  }

  it('renders nothing when there are zero tasks', async () => {
    const { rendered } = renderBanner([]);
    const { container } = await rendered;
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('renders nothing when the only tasks are pending or failed', async () => {
    const { rendered } = renderBanner([
      task({ sessionId: 'a', status: 'pending' }),
      task({ sessionId: 'b', status: 'failed', error: 'boom' }),
    ]);
    const { container } = await rendered;
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('lists only the succeeded tasks out of a mixed set', async () => {
    const { rendered } = renderBanner([
      task({ sessionId: 'a', status: 'pending', sessionTitle: 'Pending One' }),
      task({ sessionId: 'b', sessionTitle: 'Done Pause' }),
      task({ sessionId: 'c', action: 'stop', sessionTitle: 'Done Stop' }),
      task({ sessionId: 'd', status: 'failed', error: 'boom', sessionTitle: 'Failed One' }),
    ]);
    await rendered;
    expect(screen.getByText('Paused: Done Pause')).toBeTruthy();
    expect(screen.getByText('Stopped: Done Stop')).toBeTruthy();
    expect(screen.queryByText(/Pending One/)).toBeNull();
    expect(screen.queryByText(/Failed One/)).toBeNull();
  });

  it('succeeded pause shows title and Resume; Resume calls the resume API and removes the task', async () => {
    const { rendered, removeTask } = renderBanner([task()]);
    await rendered;

    expect(screen.getByText('Paused: My Session')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(removeTask).toHaveBeenCalledWith('session-1'));
    expect(resumeSessionCalls).toEqual(['session-1']);
  });

  it('succeeded stop shows "Stopped" with Dismiss and no Resume', async () => {
    const { rendered, removeTask } = renderBanner([task({ action: 'stop' })]);
    await rendered;

    expect(screen.getByText('Stopped: My Session')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(removeTask).toHaveBeenCalledWith('session-1');
    expect(resumeSessionCalls).toEqual([]);
  });

  it('falls back to "this session" when the task has no title', async () => {
    const { rendered } = renderBanner([task({ sessionTitle: undefined })]);
    await rendered;
    expect(screen.getByText('Paused: this session')).toBeTruthy();
  });

  it('auto-dismisses after 8 seconds (not before), and the timer is cleared on unmount', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    try {
      const { rendered, removeTask } = renderBanner([task()]);
      const { unmount } = await rendered;

      const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 8000);
      expect(call).toBeTruthy();
      expect(removeTask).not.toHaveBeenCalled();

      // Fire the registered 8 s callback: it must dismiss this task.
      act(() => {
        (call![0] as () => void)();
      });
      expect(removeTask).toHaveBeenCalledWith('session-1');

      const clearsBefore = clearTimeoutSpy.mock.calls.length;
      unmount();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearsBefore);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('renders the result banner at the top of the real DashboardPage', async () => {
    await renderDashboard([], {
      sessionStopTasks: createMockSessionStopTasks({ tasks: [task({ sessionTitle: 'Dash Session' })] }),
    });
    await waitFor(() => expect(screen.getByText('Paused: Dash Session')).toBeTruthy());
  });
});

/**
 * Owner badge on the dashboard (multi-user). The same badge the sidebar shows
 * (components/sessions/CreatorBadge.tsx, the single writer of the rule) appears
 * beside the title of a worktree row -- for the ACTIVE session, or for the PAUSED
 * session when there is none (paused rows matter most: the sidebar lists only
 * running sessions) -- and on the quick-session card. Single-user renders nothing.
 *
 * Reach, measured (control: 36 pass / 0 fail): reading only `session` (not
 * `pausedSession`) in the row fails 1 (the paused case); not rendering the badge in
 * SessionCard fails 1 (the quick case); dropping the badge's multi-user gate fails 2
 * (the single-user row and the single-user card).
 */
describe('Dashboard / owner badge (multi-user)', () => {
  const SELF = { id: 'self-uuid', username: 'me', homeDir: '/home/me' };

  function worktree() {
    return { path: '/tmp/worktree-1', branch: 'feature/foo', isMain: false, repositoryId: 'repo-1' };
  }

  function worktreeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'session-1',
      type: 'worktree',
      title: 'Owned worktree session',
      locationPath: '/tmp/worktree-1',
      status: 'active',
      activationState: 'running',
      createdAt: new Date().toISOString(),
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      repositoryId: 'repo-1',
      repositoryName: 'repo',
      worktreeId: 'feature/foo',
      isMainWorktree: false,
      ...overrides,
    } as Session;
  }

  function renderRow(props: { session?: Session; pausedSession?: Session }) {
    return renderWithRouter(
      <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
        <SessionStopTasksContext.Provider value={createMockSessionStopTasks()}>
          <WorktreeRow
            worktree={worktree()}
            session={props.session as never}
            pausedSession={props.pausedSession}
            repositoryId="repo-1"
            isPulling={false}
            onPull={() => {}}
          />
        </SessionStopTasksContext.Provider>
      </WorktreeDeletionTasksContext.Provider>
    );
  }

  afterEach(() => {
    cleanup();
    resetAuth();
  });

  it('active worktree row: shows the owner badge in the "mine" colour for the current user\'s session', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    await renderRow({ session: worktreeSession({ createdBy: 'self-uuid', createdByUsername: 'me', activityState: 'idle' } as Partial<Session>) });

    const badge = screen.getByTestId('session-creator-username');
    expect(badge.textContent).toBe('me');
    expect(badge.className).toContain('bg-indigo-500/20');
  });

  it('active worktree row: shows the owner badge in the "others" colour for another user\'s session', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    await renderRow({ session: worktreeSession({ createdBy: 'bob-uuid', createdByUsername: 'bob', activityState: 'idle' } as Partial<Session>) });

    const badge = screen.getByTestId('session-creator-username');
    expect(badge.textContent).toBe('bob');
    expect(badge.className).toContain('bg-amber-500/20');
  });

  it('PAUSED worktree row (no active session): shows the paused session\'s owner', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    await renderRow({
      pausedSession: worktreeSession({ id: 'paused-1', status: 'inactive', activationState: 'hibernated', createdBy: 'bob-uuid', createdByUsername: 'bob' }),
    });

    const badge = screen.getByTestId('session-creator-username');
    expect(badge.textContent).toBe('bob');
    expect(badge.className).toContain('bg-amber-500/20');
  });

  it('a worktree row with no session at all renders no badge', async () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    await renderRow({});
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });

  it('single-user: the worktree row renders no badge even when the session has an owner username', async () => {
    await renderRow({ session: worktreeSession({ createdBy: 'self-uuid', createdByUsername: 'me', activityState: 'idle' } as Partial<Session>) });
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });

  it('quick SessionCard: shows the owner badge in multi-user mode, and none in single-user mode', async () => {
    const quick = {
      id: 'quick-1',
      type: 'quick',
      title: 'Quick',
      locationPath: '/tmp/quick-1',
      status: 'active',
      activationState: 'running',
      createdAt: new Date().toISOString(),
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      createdBy: 'bob-uuid',
      createdByUsername: 'bob',
    } as Session;

    setAuthMode('multi-user');
    setCurrentUser(SELF);
    await renderWithRouter(
      <SessionStopTasksContext.Provider value={createMockSessionStopTasks()}>
        <SessionCard session={quick} />
      </SessionStopTasksContext.Provider>
    );
    const badge = screen.getByTestId('session-creator-username');
    expect(badge.textContent).toBe('bob');
    expect(badge.className).toContain('bg-amber-500/20');

    cleanup();
    resetAuth();
    await renderWithRouter(
      <SessionStopTasksContext.Provider value={createMockSessionStopTasks()}>
        <SessionCard session={quick} />
      </SessionStopTasksContext.Provider>
    );
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });
});

describe('WorktreeRow / End Session button', () => {
  function worktreeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'session-1',
      type: 'worktree',
      title: 'Live Session',
      locationPath: '/tmp/worktree-1',
      status: 'active',
      activationState: 'running',
      createdAt: new Date().toISOString(),
      workers: [],
      isShared: false,
      recoveryState: 'healthy',
      repositoryId: 'repo-1',
      repositoryName: 'repo',
      worktreeId: 'feature/foo',
      isMainWorktree: false,
      ...overrides,
    } as Session;
  }

  function renderRow(props: { session?: Session; pausedSession?: Session; isMain?: boolean }, stopTasks = createMockSessionStopTasks()) {
    return renderWithRouter(
      <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
        <SessionStopTasksContext.Provider value={stopTasks}>
          <WorktreeRow
            worktree={{ path: '/tmp/worktree-1', branch: 'feature/foo', isMain: props.isMain ?? false, repositoryId: 'repo-1' } as never}
            session={props.session as never}
            pausedSession={props.pausedSession}
            repositoryId="repo-1"
            isPulling={false}
            onPull={() => {}}
          />
        </SessionStopTasksContext.Provider>
      </WorktreeDeletionTasksContext.Provider>
    );
  }

  afterEach(() => {
    cleanup();
  });

  it('active row: shows End next to Open and confirming ends that session', async () => {
    const stopTasks = createMockSessionStopTasks();
    await renderRow({ session: worktreeSession() }, stopTasks);

    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End' }));
    });
    const confirm = await screen.findByRole('button', { name: 'End Session' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(stopTasks.addTask).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'stop', sessionTitle: 'Live Session' });
  });

  it('paused row: shows End next to Resume and confirming ends the paused session', async () => {
    const stopTasks = createMockSessionStopTasks();
    await renderRow({ pausedSession: worktreeSession({ id: 'paused-1', title: 'Paused Session' }) }, stopTasks);

    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End' }));
    });
    const confirm = await screen.findByRole('button', { name: 'End Session' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(stopTasks.addTask).toHaveBeenCalledWith({ sessionId: 'paused-1', action: 'stop', sessionTitle: 'Paused Session' });
  });

  it('paused row: a stop task in flight for the paused session shows the Stopping indicator', async () => {
    const stopTasks = createMockSessionStopTasks({
      tasks: [{ sessionId: 'paused-1', action: 'stop', status: 'pending', error: null }],
      getTask: mock((sessionId: string) =>
        sessionId === 'paused-1' ? { sessionId, action: 'stop' as const, status: 'pending' as const, error: null } : undefined,
      ),
    });
    await renderRow({ pausedSession: worktreeSession({ id: 'paused-1', title: 'Paused Session' }) }, stopTasks);

    expect(screen.getByText('Stopping...')).toBeTruthy();
  });

  it('paused row: a failed End shows the error with a Dismiss control that clears it', async () => {
    const removeTask = mock(() => {});
    const failed = { sessionId: 'paused-1', action: 'stop' as const, status: 'failed' as const, error: 'delete failed' };
    const stopTasks = createMockSessionStopTasks({
      tasks: [failed],
      getTask: mock((sessionId: string) => (sessionId === 'paused-1' ? failed : undefined)),
      removeTask,
    });
    await renderRow({ pausedSession: worktreeSession({ id: 'paused-1', title: 'Paused Session' }) }, stopTasks);

    expect(screen.getByText('delete failed')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(removeTask).toHaveBeenCalledWith('paused-1');
  });

  it('primary-worktree row (isMain) with a session: End is shown while Delete stays hidden', async () => {
    await renderRow({ session: worktreeSession({ isMainWorktree: true }), isMain: true });

    expect(screen.getByRole('button', { name: 'End' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('restore row (no live or paused session): no End button', async () => {
    await renderRow({});

    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
  });
});
