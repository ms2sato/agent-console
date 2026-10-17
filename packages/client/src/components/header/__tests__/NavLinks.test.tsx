import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { completeWireBody } from '../../../test/wire-fixtures';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { TopNavLink, ValidationWarningIndicator } from '../NavLinks';
import { NAV_ITEMS, type NavItem } from '../nav-items';

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

function item(id: string): NavItem {
  const found = NAV_ITEMS.find((i) => i.id === id);
  if (!found) throw new Error(`no nav item ${id}`);
  return found;
}

describe('TopNavLink', () => {
  it('links to the item destination with its label', async () => {
    await renderWithRouter(<TopNavLink item={item('artifacts')} />);
    const link = screen.getByRole('link', { name: 'Artifacts' });
    expect(link.getAttribute('href')).toBe('/artifacts');
  });

  it('is active on the item path and its sub-paths, inactive elsewhere', async () => {
    await renderWithRouter(<TopNavLink item={item('artifacts')} />, '/artifacts');
    expect(screen.getByRole('link').className).toContain('text-white');
    expect(screen.getByRole('link').className).toContain('bg-white/10');
    cleanup();
    await renderWithRouter(<TopNavLink item={item('artifacts')} />, '/artifacts/123');
    expect(screen.getByRole('link').className).toContain('bg-white/10');
    cleanup();
    await renderWithRouter(<TopNavLink item={item('artifacts')} />, '/jobs');
    expect(screen.getByRole('link').className).toContain('text-slate-400');
    expect(screen.getByRole('link').className).not.toContain('bg-white/10');
  });

  it('is active on /todos and /review for their own items', async () => {
    await renderWithRouter(<TopNavLink item={item('todos')} />, '/todos');
    expect(screen.getByRole('link').className).toContain('bg-white/10');
    cleanup();
    await renderWithRouter(<TopNavLink item={item('review')} />, '/review');
    expect(screen.getByRole('link').className).toContain('bg-white/10');
    cleanup();
    await renderWithRouter(<TopNavLink item={item('todos')} />, '/jobs');
    expect(screen.getByRole('link').className).not.toContain('bg-white/10');
  });

  it('shows no badge for an item without one', async () => {
    reviewQueueResponse = [{ sourceSessionId: 's1', sourceSessionTitle: 'S', items: [{ workerId: 'w' }] }];
    await renderWithRouter(<TopNavLink item={item('artifacts')} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('link').textContent).toBe('Artifacts');
  });

  it('shows the Todo count for the todos item', async () => {
    setCurrentUser({ id: 'user-me', username: 'me', homeDir: '/home/me' });
    todosResponse = {
      todos: [
        { ...baseTodo, id: 'a', assigneeUserId: 'user-me' },
        { ...baseTodo, id: 'b', assigneeUserId: 'user-me' },
      ],
    };
    await renderWithRouter(<TopNavLink item={item('todos')} />);
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /2 open Todo items assigned to you/ }).getAttribute('href'),
      ).toBe('/todos');
    });
  });

  it('shows no review badge when there are no pending items', async () => {
    reviewQueueResponse = [];
    await renderWithRouter(<TopNavLink item={item('review')} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('shows the pending count for the review item', async () => {
    reviewQueueResponse = [
      { sourceSessionId: 's1', sourceSessionTitle: 'Session 1', items: [{ workerId: 'item-1' }, { workerId: 'item-2' }] },
      { sourceSessionId: 's2', sourceSessionTitle: 'Session 2', items: [{ workerId: 'item-3' }] },
    ];
    await renderWithRouter(<TopNavLink item={item('review')} />);
    await waitFor(() => {
      expect(screen.getByText('3')).toBeTruthy();
    });
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

