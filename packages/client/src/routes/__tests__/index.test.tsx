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
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { DashboardPage } from '../index';
import { SessionDataContext, WorktreeDeletionTasksContext, WorktreeCreationTasksContext } from '../../contexts/root-contexts';
import { renderWithRouter } from '../../test/renderWithRouter';
import type { Repository } from '@agent-console/shared';
import type { UseWorktreeDeletionTasksReturn } from '../../hooks/useWorktreeDeletionTasks';
import type { UseWorktreeCreationTasksReturn } from '../../hooks/useWorktreeCreationTasks';
import * as useAppWsModule from '../../hooks/useAppWs';
import * as capabilitiesModule from '../../lib/capabilities';

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
}

let fetchResponses: FetchResponses = {
  repositories: [],
  worktreesByRepoId: {},
};

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  // GET /api/repositories
  if (method === 'GET' && /\/api\/repositories(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ repositories: fetchResponses.repositories }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/repositories/:id/worktrees
  if (method === 'GET' && /\/api\/repositories\/[^/]+\/worktrees$/.test(url)) {
    const match = url.match(/\/api\/repositories\/([^/]+)\/worktrees/);
    const repoId = match?.[1] ?? '';
    const worktrees = fetchResponses.worktreesByRepoId[repoId] ?? [];
    return new Response(JSON.stringify({ worktrees }), {
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

  // Default: empty success response (covers branches lookups, etc.)
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

globalThis.fetch = mockFetch as unknown as typeof fetch;

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

// --- Render helper ---

async function renderDashboard(
  repositories: Repository[],
  options?: {
    deleteRepositoryResponses?: Record<string, { status: number; body?: unknown }>;
    deleteRepositoryCalls?: string[];
    deleteRepositoryBodies?: unknown[];
  }
) {
  fetchResponses = {
    repositories: [...repositories],
    worktreesByRepoId: Object.fromEntries(repositories.map((r) => [r.id, []])),
    deleteRepositoryResponses: options?.deleteRepositoryResponses,
    deleteRepositoryCalls: options?.deleteRepositoryCalls,
    deleteRepositoryBodies: options?.deleteRepositoryBodies,
  };

  const sessionDataValue = {
    sessions: [],
    wsInitialized: true,
    workerActivityStates: {},
  };

  return renderWithRouter(
    <SessionDataContext.Provider value={sessionDataValue}>
      <WorktreeCreationTasksContext.Provider value={createMockCreationContext()}>
        <WorktreeDeletionTasksContext.Provider value={createMockDeletionContext()}>
          <DashboardPage />
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
      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: 'Add Repository', level: 2 })).toBeNull();
      });
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
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Unregister Repository' })).toBeNull();
    });

    // Trigger a refetch (production code calls invalidateQueries; force the refetch deterministically here).
    await queryClient.refetchQueries({ queryKey: ['repositories'] });

    // Repository card is gone — the DELETE handler removed it from the response set, so the refetch reflects the deletion.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'my-repo', level: 2 })).toBeNull();
    });

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
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Unregister Repository' })).toBeNull();
    });

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
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Unregister Repository' })).toBeNull();
    });

    // Re-open: checkbox state should be reset to unchecked.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Unregister Repository' })).toBeTruthy();
    });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});
