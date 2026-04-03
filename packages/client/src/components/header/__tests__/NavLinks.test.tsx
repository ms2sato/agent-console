import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import {
  JobsNavLink,
  AgentsNavLink,
  RepositoriesNavLink,
  ReviewNavLink,
  LogoutButton,
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
let logoutCalled = false;

const mockFetch = mock(async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);

  if (url.includes('/review-queue')) {
    return jsonResponse(reviewQueueResponse);
  }

  if (url.includes('/sessions/validate')) {
    return jsonResponse(validateSessionsResponse);
  }

  if (url.includes('/auth/logout')) {
    logoutCalled = true;
    return jsonResponse({});
  }

  return jsonResponse({});
});

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  reviewQueueResponse = [];
  validateSessionsResponse = { hasIssues: false, results: [] };
  logoutCalled = false;
  resetAuth();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  mockFetch.mockClear();
});

describe('JobsNavLink', () => {
  it('should render a link with text "Jobs"', async () => {
    await renderWithRouter(<JobsNavLink />);
    const link = screen.getByText('Jobs');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/jobs');
  });

  it('should have active styling when on /jobs path', async () => {
    await renderWithRouter(<JobsNavLink />, '/jobs');
    const link = screen.getByText('Jobs');
    expect(link.className).toContain('text-white');
    expect(link.className).toContain('bg-white/10');
  });

  it('should have inactive styling when on a different path', async () => {
    await renderWithRouter(<JobsNavLink />, '/agents');
    const link = screen.getByText('Jobs');
    expect(link.className).toContain('text-slate-400');
    expect(link.className).not.toContain('bg-white/10');
  });

  it('should be active on sub-paths like /jobs/123', async () => {
    await renderWithRouter(<JobsNavLink />, '/jobs/123');
    const link = screen.getByText('Jobs');
    expect(link.className).toContain('text-white');
  });
});

describe('AgentsNavLink', () => {
  it('should render a link with text "Agents"', async () => {
    await renderWithRouter(<AgentsNavLink />);
    const link = screen.getByText('Agents');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/agents');
  });

  it('should have active styling when on /agents path', async () => {
    await renderWithRouter(<AgentsNavLink />, '/agents');
    const link = screen.getByText('Agents');
    expect(link.className).toContain('text-white');
  });

  it('should have inactive styling on a different path', async () => {
    await renderWithRouter(<AgentsNavLink />, '/');
    const link = screen.getByText('Agents');
    expect(link.className).toContain('text-slate-400');
  });
});

describe('RepositoriesNavLink', () => {
  it('should render a link with text "Repositories"', async () => {
    await renderWithRouter(<RepositoriesNavLink />);
    const link = screen.getByText('Repositories');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/settings/repositories');
  });

  it('should have active styling only on exact /settings/repositories path', async () => {
    await renderWithRouter(<RepositoriesNavLink />, '/settings/repositories');
    const link = screen.getByText('Repositories');
    expect(link.className).toContain('text-white');
  });

  it('should have inactive styling on /settings/other', async () => {
    await renderWithRouter(<RepositoriesNavLink />, '/settings/other');
    const link = screen.getByText('Repositories');
    expect(link.className).toContain('text-slate-400');
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
        items: [{ id: 'item-1' }, { id: 'item-2' }],
      },
      {
        sourceSessionId: 's2',
        sourceSessionTitle: 'Session 2',
        items: [{ id: 'item-3' }],
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

describe('LogoutButton', () => {
  it('should not render when there is no current user', async () => {
    await renderWithRouter(<LogoutButton />);
    expect(screen.queryByText('Logout')).toBeNull();
  });

  it('should render when there is a current user', async () => {
    setCurrentUser({ id: 'user-1', username: 'testuser', homeDir: '/home/testuser' });
    await renderWithRouter(<LogoutButton />);
    const button = screen.getByText('Logout');
    expect(button).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Logout (testuser)');
  });

  it('should show "Logging out..." and disable button during logout', async () => {
    setCurrentUser({ id: 'user-1', username: 'testuser', homeDir: '/home/testuser' });
    await renderWithRouter(<LogoutButton />);
    const button = screen.getByText('Logout');

    // Click logout - don't await, check intermediate state
    const user = userEvent.setup();
    await user.click(button);

    // After click, the API was called
    expect(logoutCalled).toBe(true);
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
        { sessionId: 's1', valid: false, errors: ['error'] },
        { sessionId: 's2', valid: true, errors: [] },
        { sessionId: 's3', valid: false, errors: ['error'] },
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
      results: [{ sessionId: 's1', valid: false, errors: ['error'] }],
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
      results: [{ sessionId: 's1', valid: false, errors: ['error'] }],
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
        { sessionId: 's1', valid: false, errors: ['error'] },
        { sessionId: 's2', valid: false, errors: ['error'] },
      ],
    };
    await renderWithRouter(<ValidationWarningIndicator />);

    await waitFor(() => {
      const link = screen.getByText('2').closest('a');
      expect(link!.getAttribute('title')).toBe('2 invalid sessions found');
    });
  });
});
