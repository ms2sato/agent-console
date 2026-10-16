import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { completeWireBody } from '../../../test/wire-fixtures';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import {
  TodosNavLink,
  ArtifactsNavLink,
  ReviewNavLink,
  ValidationWarningIndicator,
} from '../NavLinks';

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let reviewQueueResponse: unknown = [];
let validateSessionsResponse: unknown = { hasIssues: false, results: [] };
let todosResponse: unknown = { todos: [] };

const baseTodo = {
  kind: 'action',
  scope: 'global',
  title: 'Run the migration',
  body: '',
  sessionId: null,
  createdBy: { userId: 'user-me' },
  assigneeUserId: null,
  status: 'open',
  resolutionText: null,
  resolvedByUserId: null,
  resolvedByWorkerId: null,
  resolvedAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};

const mockFetch = mock(async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);

  if (url.includes('/api/todos')) {
    return jsonResponse(todosResponse);
  }

  if (url.includes('/review-queue')) {
    return jsonResponse(completeWireBody(reviewQueueResponse));
  }

  if (url.includes('/sessions/validate')) {
    return jsonResponse(completeWireBody(validateSessionsResponse));
  }

  return jsonResponse({});
});

beforeEach(() => {
  globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
  reviewQueueResponse = [];
  validateSessionsResponse = { hasIssues: false, results: [] };
  todosResponse = { todos: [] };
  resetAuth();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  mockFetch.mockClear();
});

describe('TodosNavLink', () => {
  it('links to /todos with the label "Todo"', async () => {
    await renderWithRouter(<TodosNavLink />);
    const link = screen.getByText('Todo').closest('a');
    expect(link?.getAttribute('href')).toBe('/todos');
  });

  it('is active on /todos and inactive elsewhere', async () => {
    await renderWithRouter(<TodosNavLink />, '/todos');
    expect(screen.getByText('Todo').closest('a')?.className).toContain('bg-white/10');
    cleanup();
    await renderWithRouter(<TodosNavLink />, '/jobs');
    expect(screen.getByText('Todo').closest('a')?.className).not.toContain('bg-white/10');
  });

  it('shows the number of open items assigned to the current user', async () => {
    setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
    todosResponse = {
      todos: [
        { ...baseTodo, id: 'a', assigneeUserId: 'user-me' },
        { ...baseTodo, id: 'b', assigneeUserId: 'user-me' },
      ],
    };
    await renderWithRouter(<TodosNavLink />);
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /2 open Todo items assigned to you/ }).getAttribute('href'),
      ).toBe('/todos');
    });
  });
});

describe('ArtifactsNavLink', () => {
  it('should render a link with text "Artifacts"', async () => {
    await renderWithRouter(<ArtifactsNavLink />);
    const link = screen.getByText('Artifacts');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/artifacts');
  });

  it('should have active styling when on /artifacts path', async () => {
    await renderWithRouter(<ArtifactsNavLink />, '/artifacts');
    const link = screen.getByText('Artifacts');
    expect(link.className).toContain('text-white');
    expect(link.className).toContain('bg-white/10');
  });

  it('should have inactive styling when on a different path', async () => {
    await renderWithRouter(<ArtifactsNavLink />, '/jobs');
    const link = screen.getByText('Artifacts');
    expect(link.className).toContain('text-slate-400');
    expect(link.className).not.toContain('bg-white/10');
  });

  it('should be active on sub-paths like /artifacts/123', async () => {
    await renderWithRouter(<ArtifactsNavLink />, '/artifacts/123');
    const link = screen.getByText('Artifacts');
    expect(link.className).toContain('text-white');
  });
});

describe('ReviewNavLink', () => {
  it('should render a link with text "Review"', async () => {
    await renderWithRouter(<ReviewNavLink />);
    const link = screen.getByText('Review');
    expect(link).toBeTruthy();
  });

  it('should not show badge when there are no pending items', async () => {
    reviewQueueResponse = [];
    await renderWithRouter(<ReviewNavLink />);
    // No badge should be rendered
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('should show pending count badge when there are review items', async () => {
    reviewQueueResponse = [
      {
        sourceSessionId: 's1',
        sourceSessionTitle: 'Session 1',
        items: [{ workerId: 'item-1' }, { workerId: 'item-2' }],
      },
      {
        sourceSessionId: 's2',
        sourceSessionTitle: 'Session 2',
        items: [{ workerId: 'item-3' }],
      },
    ];
    await renderWithRouter(<ReviewNavLink />);

    // Wait for the query to resolve and badge to appear
    await waitFor(() => {
      expect(screen.getByText('3')).toBeTruthy();
    });
  });

  it('should have active styling when on /review path', async () => {
    await renderWithRouter(<ReviewNavLink />, '/review');
    const link = screen.getByText('Review');
    expect(link.closest('a')!.className).toContain('text-white');
  });
});

describe('ValidationWarningIndicator', () => {
  it('should not render when there are no issues', async () => {
    validateSessionsResponse = { hasIssues: false, results: [] };
    await renderWithRouter(<ValidationWarningIndicator />);
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('should render warning with invalid count when there are issues', async () => {
    validateSessionsResponse = {
      hasIssues: true,
      results: [
        { sessionId: 's1', valid: false },
        { sessionId: 's2', valid: true },
        { sessionId: 's3', valid: false },
      ],
    };
    await renderWithRouter(<ValidationWarningIndicator />);

    await waitFor(() => {
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  it('should link to /maintenance page', async () => {
    validateSessionsResponse = {
      hasIssues: true,
      results: [{ sessionId: 's1', valid: false }],
    };
    await renderWithRouter(<ValidationWarningIndicator />);

    await waitFor(() => {
      const link = screen.getByText('1').closest('a');
      expect(link).toBeTruthy();
      expect(link!.getAttribute('href')).toBe('/maintenance');
    });
  });

  it('should show correct title for single invalid session', async () => {
    validateSessionsResponse = {
      hasIssues: true,
      results: [{ sessionId: 's1', valid: false }],
    };
    await renderWithRouter(<ValidationWarningIndicator />);

    await waitFor(() => {
      const link = screen.getByText('1').closest('a');
      expect(link!.getAttribute('title')).toBe('1 invalid session found');
    });
  });

  it('should show plural title for multiple invalid sessions', async () => {
    validateSessionsResponse = {
      hasIssues: true,
      results: [
        { sessionId: 's1', valid: false },
        { sessionId: 's2', valid: false },
      ],
    };
    await renderWithRouter(<ValidationWarningIndicator />);

    await waitFor(() => {
      const link = screen.getByText('2').closest('a');
      expect(link!.getAttribute('title')).toBe('2 invalid sessions found');
    });
  });
});

