import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SharedAccountsPage } from '../shared-accounts';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { setAuthMode, setSharedAccountsEnvVarIgnored, _reset as resetAuth } from '../../../lib/auth';

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
    { username: 'shared-bot', registeredAt: '2026-01-01T00:00:00Z', boundRepositoryCount: 0, sessionCount: 0, resolvable: true },
    { username: 'ci-runner', registeredAt: '2026-01-02T00:00:00Z', boundRepositoryCount: 2, sessionCount: 3, resolvable: true },
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
      expect(screen.queryByText(/AGENT_CONSOLE_SHARED_USERNAME is set/)).toBeNull();
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

    it('shows an "unresolvable" badge for an account whose OS user no longer resolves', async () => {
      setAuthMode('multi-user');
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes('/api/shared-accounts')) {
          return Promise.resolve(
            jsonResponse({
              accounts: [
                { username: 'shared-bot', registeredAt: '2026-01-01T00:00:00Z', boundRepositoryCount: 0, sessionCount: 0, resolvable: true },
                { username: 'gone-user', registeredAt: '2026-01-03T00:00:00Z', boundRepositoryCount: 1, sessionCount: 1, resolvable: false },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      });

      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('gone-user')).toBeTruthy();
      });

      expect(screen.getByText('unresolvable')).toBeTruthy();
      // The resolvable account must not also carry the badge.
      const sharedBotRow = screen.getByText('shared-bot').closest('div');
      expect(sharedBotRow?.textContent).not.toMatch(/unresolvable/);
    });
  });

  describe('register', () => {
    it('registers a new account, invalidates the list, and clears the input', async () => {
      setAuthMode('multi-user');
      const user = userEvent.setup();
      mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes('/api/shared-accounts') && init?.method === 'POST') {
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
        if (url.includes('/api/shared-accounts') && init?.method === 'POST') {
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

  describe('env-var-ignored banner (Issue #1842 item 6b, Release 2)', () => {
    it('is hidden when sharedAccountsEnvVarIgnored is false', async () => {
      setAuthMode('multi-user');
      setSharedAccountsEnvVarIgnored(false);
      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(screen.getByText('shared-bot')).toBeTruthy();
      });
      expect(screen.queryByText(/AGENT_CONSOLE_SHARED_USERNAME is set/)).toBeNull();
    });

    it('shows the banner with the exact AC wording when sharedAccountsEnvVarIgnored is true', async () => {
      setAuthMode('multi-user');
      setSharedAccountsEnvVarIgnored(true);
      await renderWithRouter(<SharedAccountsPage />);

      await waitFor(() => {
        expect(
          screen.getByText(
            'AGENT_CONSOLE_SHARED_USERNAME is set but no longer used; register and bind accounts here, then remove it from the unit file.',
          ),
        ).toBeTruthy();
      });
    });
  });
});
