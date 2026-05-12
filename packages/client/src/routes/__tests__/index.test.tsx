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

async function renderDashboard(repositories: Repository[]) {
  fetchResponses = {
    repositories,
    worktreesByRepoId: Object.fromEntries(repositories.map((r) => [r.id, []])),
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
