/**
 * Tests for the Repository Detail page Delete flow (Issue #905 source-repo
 * cleanup checkbox).
 *
 * Mirrors the structure of `routes/__tests__/index.test.tsx`:
 *  - `spyOn` (NOT `mock.module`) for any module-level hooks.
 *  - fetch-level mocking for the repository GET / DELETE round-trips.
 *  - `renderWithRouter` for QueryClient + minimal TanStack Router context
 *    (needed because `useNavigate()` is used on success).
 *
 * The route's `RepositoryDetailPage` component uses `Route.useParams()` to
 * read `repositoryId` from the matched route, which would require mounting
 * the full route tree. To keep the test surface-area aligned with the unit
 * under test, we render `RepositoryDetailView` directly — the presentational
 * inner component extracted from the route handler. Production callers still
 * go through `RepositoryDetailPage`; only the read of `repositoryId` differs.
 */
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { Suspense } from 'react';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { RepositoryDetailView } from '../index';
import { renderWithRouter } from '../../../../../test/renderWithRouter';
import type { Repository } from '@agent-console/shared';

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch;

interface FetchResponses {
  /** Repository returned by GET /api/repositories/:id */
  repository: Repository | null;
  /**
   * Optional override for DELETE /api/repositories/:id responses.
   * When absent, the DELETE returns 204 No Content.
   */
  deleteResponse?: { status: number; body?: unknown };
  /** Recorded DELETE bodies (parsed JSON, or `undefined` when body is absent). */
  deleteBodies?: unknown[];
}

let fetchResponses: FetchResponses = { repository: null };

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  // GET /api/repositories/:id
  if (method === 'GET' && /\/api\/repositories\/[^/]+(\?|$)/.test(url) && !/\/(worktrees|branches|integrations|generate-description|github-issue|refresh-default-branch)/.test(url)) {
    return new Response(JSON.stringify({ repository: fetchResponses.repository }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // GET /api/agents (fallback for AgentSelector / lookup)
  if (method === 'GET' && /\/api\/agents(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DELETE /api/repositories/:id
  if (method === 'DELETE' && /\/api\/repositories\/[^/]+$/.test(url)) {
    if (fetchResponses.deleteBodies) {
      const rawBody = init?.body;
      let parsed: unknown = undefined;
      if (typeof rawBody === 'string' && rawBody.length > 0) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }
      fetchResponses.deleteBodies.push(parsed);
    }
    const override = fetchResponses.deleteResponse;
    if (override) {
      const body = override.body === undefined ? null : override.body;
      return new Response(body === null ? null : JSON.stringify(body), {
        status: override.status,
        headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  }

  throw new Error(`Unhandled fetch request in RepositoryDetailView test: ${method} ${url}`);
});

globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// --- Test data factory ---

function createTestRepository(overrides?: Partial<Repository>): Repository {
  return {
    id: 'repo-1',
    name: 'my-repo',
    path: '/test/repos/my-repo',
    createdAt: new Date().toISOString(),
    clonedSourceRepoPath: null,
    ...overrides,
  } as Repository;
}

async function renderDetailPage(
  repository: Repository,
  options?: {
    deleteResponse?: { status: number; body?: unknown };
    deleteBodies?: unknown[];
  }
) {
  fetchResponses = {
    repository,
    deleteResponse: options?.deleteResponse,
    deleteBodies: options?.deleteBodies,
  };

  return renderWithRouter(
    <Suspense fallback={<div>Loading...</div>}>
      <RepositoryDetailView repositoryId={repository.id} />
    </Suspense>
  );
}

describe('RepositoryDetailView / Delete Repository — source-repo cleanup checkbox', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT render the checkbox when clonedSourceRepoPath is null', async () => {
    await renderDetailPage(createTestRepository({ clonedSourceRepoPath: null }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 1 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete Repository' })).toBeTruthy();
    });

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders the checkbox with the path label when clonedSourceRepoPath is non-null', async () => {
    const clonedPath = '/test/source-repos/my-repo';
    await renderDetailPage(
      createTestRepository({ clonedSourceRepoPath: clonedPath })
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 1 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete Repository' })).toBeTruthy();
    });

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    expect(screen.getByText(clonedPath)).toBeTruthy();
  });

  it('passes removeSourceRepo: true in the DELETE body when checked and confirmed', async () => {
    const deleteBodies: unknown[] = [];
    await renderDetailPage(
      createTestRepository({ clonedSourceRepoPath: '/test/source-repos/my-repo' }),
      { deleteBodies }
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 1 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete Repository' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('checkbox'));

    // Radix's destructive AlertDialog renders the confirm button with label "Delete";
    // there are two buttons named "Delete" at this point (the header trigger + the
    // confirm in the dialog). The dialog's confirm button is the second/most recent one
    // and is also accessible — use the role+name pair after dialog opens.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    // The dialog's confirm button is the one inside the open AlertDialog.
    // It's the only one whose closest dialog ancestor is non-null.
    const confirmButton = deleteButtons.find(btn => btn.closest('[role="alertdialog"]') !== null);
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(deleteBodies).toEqual([{ removeSourceRepo: true }]);
    });
  });

  it('omits the body when the checkbox stays unchecked and confirmed', async () => {
    const deleteBodies: unknown[] = [];
    await renderDetailPage(
      createTestRepository({ clonedSourceRepoPath: '/test/source-repos/my-repo' }),
      { deleteBodies }
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'my-repo', level: 1 })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete Repository' })).toBeTruthy();
    });

    // Don't click the checkbox.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    const confirmButton = deleteButtons.find(btn => btn.closest('[role="alertdialog"]') !== null);
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton!);

    await waitFor(() => {
      expect(deleteBodies).toEqual([undefined]);
    });
  });
});
