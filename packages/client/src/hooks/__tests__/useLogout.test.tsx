import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../test/renderWithRouter';
import { installMockWebSocket, MockWebSocket } from '../../test/mock-websocket';
import { jsonResponse, fetchUrl } from '../../test/todo-fixtures';
import { setCurrentUser, getCurrentUser, _reset as resetAuth } from '../../lib/auth';
import { connect, getState, _reset as resetWebSocket } from '../../lib/app-websocket';
import { setHomeDir, formatPath, _reset as resetPath } from '../../lib/path';
import { STORAGE_KEY } from '../useSessionFilter';
import { useLogout } from '../useLogout';

const ME = { id: 'user-me', username: 'me', homeDir: '/home/me' };
const originalFetch = globalThis.fetch;

/** What the client still held at the moment the logout request reached the server. */
interface StateAtRequest {
  user: unknown;
  connected: boolean;
  homePath: string;
  storedFilter: string | null;
  cachedValue: unknown;
}

let restoreWebSocket: () => void;
let stateAtRequest: StateAtRequest | null;
let logoutRequests: number;
let logoutResponse: () => Promise<Response>;
let queryClientRef: { getQueryData: (key: unknown[]) => unknown } | null;

function Harness() {
  const { logout, isLoggingOut } = useLogout();
  return (
    <button type="button" onClick={() => void logout()}>
      {isLoggingOut ? 'busy' : 'idle'}
    </button>
  );
}

beforeEach(() => {
  resetAuth();
  resetPath();
  resetWebSocket();
  localStorage.clear();
  restoreWebSocket = installMockWebSocket();
  stateAtRequest = null;
  logoutRequests = 0;
  queryClientRef = null;
  logoutResponse = async () => jsonResponse({});
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL): Promise<Response> => {
      if (fetchUrl(input).includes('/auth/logout')) {
        logoutRequests += 1;
        stateAtRequest = {
          user: getCurrentUser(),
          connected: getState().connected,
          homePath: formatPath('/home/me/x'),
          storedFilter: localStorage.getItem(STORAGE_KEY),
          cachedValue: queryClientRef?.getQueryData(['seed']),
        };
        return logoutResponse();
      }
      return jsonResponse({});
    }),
    { preconnect: () => {} },
  ) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  restoreWebSocket();
  resetAuth();
  resetPath();
  resetWebSocket();
  localStorage.clear();
});

async function mountLoggedIn() {
  setCurrentUser(ME);
  setHomeDir(ME.homeDir);
  localStorage.setItem(STORAGE_KEY, 'mine');
  connect();
  const ws = MockWebSocket.getLastInstance();
  if (!ws) throw new Error('Expected connect() to create a MockWebSocket');
  ws.simulateOpen();
  const view = await renderWithRouter(<Harness />, '/todos');
  view.queryClient.setQueryData(['seed'], 'cached');
  queryClientRef = view.queryClient;
  return { ...view, ws, user: userEvent.setup() };
}

describe('useLogout', () => {
  it('calls the logout API first, then clears every piece of per-user client state and goes to /login', async () => {
    const { ws, user, queryClient, router } = await mountLoggedIn();
    expect(formatPath('/home/me/x')).toBe('~/x');

    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    expect(logoutRequests).toBe(1);
    // Order: the request is made while the old session's state is still intact.
    expect(stateAtRequest).toEqual({
      user: ME,
      connected: true,
      homePath: '~/x',
      storedFilter: 'mine',
      cachedValue: 'cached',
    });
    // After: everything is cleared.
    expect(ws.close.mock.calls.length).toBe(1);
    expect(getState().connected).toBe(false);
    expect(queryClient.getQueryData(['seed'])).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getCurrentUser()).toBeNull();
    expect(formatPath('/home/me/x')).toBe('/home/me/x');
  });

  it('still clears local state when the logout API call fails', async () => {
    logoutResponse = async () => jsonResponse({ error: 'boom' }, 500);
    const { ws, user, queryClient, router } = await mountLoggedIn();

    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));

    expect(logoutRequests).toBe(1);
    expect(ws.close.mock.calls.length).toBe(1);
    expect(queryClient.getQueryData(['seed'])).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getCurrentUser()).toBeNull();
    expect(formatPath('/home/me/x')).toBe('/home/me/x');
  });

  it('reports isLoggingOut while the request is in flight and leaves state alone until it settles', async () => {
    let release: () => void = () => {};
    logoutResponse = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({}));
      });
    const { user, router } = await mountLoggedIn();

    expect(screen.getByRole('button').textContent).toBe('idle');
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('busy'));
    expect(getCurrentUser()).toEqual(ME);
    expect(router.state.location.pathname).toBe('/todos');

    release();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});
