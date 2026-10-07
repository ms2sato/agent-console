import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SharedAccountsPage } from '../shared-accounts';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { setAuthMode, setSharedAccountsAvailable, _reset as resetAuth } from '../../../lib/auth';

// Save original fetch and set up mock (fetch-level mocking per testing.md —
// the Hono RPC client (`api`) and raw `fetch` calls both resolve to
// `globalThis.fetch`).
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

const defaultAccountsResponse = {
  accounts: [
    { username: 'shared-bot', registeredAt: '2026-01-01T00:00:00Z', boundRepositoryCount: 0, sessionCount: 0 },
    { username: 'ci-runner', registeredAt: '2026-01-02T00:00:00Z', boundRepositoryCount: 2, sessionCount: 3 },
  ],
};

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  resetAuth();
});

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.includes('/api/shared-accounts')) {
      return Promise.resolve(jsonResponse(defaultAccountsResponse));
    }
    return Promise.resolve(jsonResponse({}));
  });
});

describe('SharedAccountsPage', () => {
  describe('AUTH_MODE=none', () => {
    it('hides all shared-account UI and shows the explanatory message', async () => {
      setAuthMode('none');
      await renderWithRouter(<SharedAccountsPage />);

      expect(screen.getByText(/only available in multi-user mode/i)).toBeTruthy();
      expect(screen.queryByText('Register Shared Account')).toBeNull();
      expect(screen.queryByText('Import Current Env-Var Account')).toBeNull();
      expect(screen.queryByText('shared-bot')).toBeNull();
    });
  });

  describe('list rendering', () => {
    it('renders registered accounts with their counts', async () => {
      setAuthMode('multi-user');
      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('shared-bot')).toBeTruthy();
      });
      expect(screen.getByText('ci-runner')).toBeTruthy();
      expect(screen.getByText(/0 repositories/)).toBeTruthy();
      expect(screen.getByText(/2 repositories/)).toBeTruthy();
      expect(screen.getByText(/3 sessions/)).toBeTruthy();
    });

    it('shows an empty state when no accounts are registered', async () => {
      setAuthMode('multi-user');
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse({ accounts: [] }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('No shared accounts registered yet')).toBeTruthy();
      });
    });

    it('disables the Unregister button and explains why when the account is in use', async () => {
      setAuthMode('multi-user');
      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('ci-runner')).toBeTruthy();
      });

      const rows = screen.getAllByText('Unregister');
      // shared-bot (index 0): unused, enabled
      expect((rows[0] as HTMLButtonElement).disabled).toBe(false);
      // ci-runner (index 1): bound + sessions, disabled with explanation
      const inUseButton = rows[1] as HTMLButtonElement;
      expect(inUseButton.disabled).toBe(true);
      expect(inUseButton.title).toMatch(/still bound|still has active sessions/);
    });
  });

  describe('register', () => {
    it('registers a new account, invalidates the list, and clears the input', async () => {
      setAuthMode('multi-user');
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/api/shared-accounts') && init?.method === 'POST' && !url.includes('import-env')) {
          return Promise.resolve(jsonResponse({ username: 'new-bot', userId: 'user-1' }, 201));
        }
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse(defaultAccountsResponse));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('shared-bot')).toBeTruthy();
      });

      const input = screen.getByLabelText('OS account username') as HTMLInputElement;
      await user.type(input, 'new-bot');
      await user.click(screen.getByText('Register'));

      await waitFor(() => {
        expect(input.value).toBe('');
      });
    });

    it('shows the server error message when registration fails (400/409)', async () => {
      setAuthMode('multi-user');
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/api/shared-accounts') && init?.method === 'POST' && !url.includes('import-env')) {
          return Promise.resolve(jsonResponse({ error: "'new-bot' is already registered as a shared account." }, 409));
        }
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse(defaultAccountsResponse));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('shared-bot')).toBeTruthy();
      });

      const input = screen.getByLabelText('OS account username');
      await user.type(input, 'new-bot');
      await user.click(screen.getByText('Register'));

      await waitFor(() => {
        expect(screen.getByText("'new-bot' is already registered as a shared account.")).toBeTruthy();
      });
    });
  });

  describe('import env-var account', () => {
    it('is hidden when sharedAccountsAvailable is false', async () => {
      setAuthMode('multi-user');
      setSharedAccountsAvailable(false);
      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('shared-bot')).toBeTruthy();
      });
      expect(screen.queryByText('Import Current Env-Var Account')).toBeNull();
    });

    it('shows a success message when imported: true', async () => {
      setAuthMode('multi-user');
      setSharedAccountsAvailable(true);
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/import-env')) {
          return Promise.resolve(jsonResponse({ imported: true }));
        }
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse(defaultAccountsResponse));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await user.click(screen.getByText('Import current env-var account'));

      await waitFor(() => {
        expect(screen.getByText('Imported the env-var shared account.')).toBeTruthy();
      });
    });

    it('shows an informational message when imported: false', async () => {
      setAuthMode('multi-user');
      setSharedAccountsAvailable(true);
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/import-env')) {
          return Promise.resolve(jsonResponse({ imported: false }));
        }
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse(defaultAccountsResponse));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await user.click(screen.getByText('Import current env-var account'));

      await waitFor(() => {
        expect(screen.getByText('The env-var shared account is already registered.')).toBeTruthy();
      });
    });

    it('shows the "no env-var account configured" message on a 404', async () => {
      setAuthMode('multi-user');
      setSharedAccountsAvailable(true);
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/import-env')) {
          return Promise.resolve(jsonResponse({ error: 'No env-var shared account is configured' }, 404));
        }
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(jsonResponse(defaultAccountsResponse));
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await user.click(screen.getByText('Import current env-var account'));

      await waitFor(() => {
        expect(screen.getByText('No env-var shared account is configured.')).toBeTruthy();
      });
    });
  });
});
