/**
 * Tests for the LogoutButton behavior.
 *
 * Uses a test harness that replicates the LogoutButton logic,
 * testing the auth state transitions and loading state.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { setAuthMode, setCurrentUser, getCurrentUser, _reset as resetAuth, useAuth } from '../../lib/auth';
import { clearStoredFilterMode, STORAGE_KEY } from '../../hooks/useSessionFilter';

/**
 * Test harness that mirrors LogoutButton logic with an injectable logout function.
 *
 * Intentional: state is always cleared even on API failure,
 * matching production behavior in LogoutButton.
 * A network error should not trap the user in a logged-in state.
 */
function LogoutButtonTestHarness({ logoutFn }: { logoutFn: () => Promise<void> }) {
  const { currentUser } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [navigatedTo, setNavigatedTo] = useState<string | null>(null);

  if (navigatedTo) return <div>Navigated to {navigatedTo}</div>;

  if (!currentUser) return <div>No user</div>;

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutFn();
    } catch {
      // Even if API fails, clear local state
    }
    clearStoredFilterMode();
    // Set navigation target before clearing user, because clearing user
    // triggers a re-render via useAuth() which would show "No user" first
    setNavigatedTo('/login');
    setCurrentUser(null);
  };

  return (
    <button
      onClick={handleLogout}
      disabled={isLoggingOut}
      title={`Logout (${currentUser.username})`}
    >
      {isLoggingOut ? 'Logging out...' : 'Logout'}
    </button>
  );
}

describe('LogoutButton', () => {
  beforeEach(() => {
    resetAuth();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('should not render when no user is logged in', () => {
    setAuthMode('multi-user');
    const logoutFn = mock(() => Promise.resolve());

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    expect(screen.getByText('No user')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('should show Logout button with username when user is logged in', () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    const logoutFn = mock(() => Promise.resolve());

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    const button = screen.getByRole('button', { name: 'Logout' });
    expect(button).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Logout (alice)');
  });

  it('should show loading state during logout', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

    let resolveLogout: () => void;
    const logoutFn = mock(() => new Promise<void>((resolve) => {
      resolveLogout = resolve;
    }));

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => {
      expect(screen.getByText('Logging out...')).toBeTruthy();
    });

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);

    // Resolve the logout to complete and wait for state transition
    resolveLogout!();
    await waitFor(() => {
      expect(screen.queryByText('Logging out...')).toBeNull();
    });
  });

  it('should clear user and navigate on successful logout', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    const logoutFn = mock(() => Promise.resolve());

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => {
      expect(screen.getByText('Navigated to /login')).toBeTruthy();
    });

    expect(getCurrentUser()).toBeNull();
  });

  it('should clear user even if logout API fails', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    const logoutFn = mock(() => Promise.reject(new Error('Network error')));

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => {
      expect(screen.getByText('Navigated to /login')).toBeTruthy();
    });

    expect(getCurrentUser()).toBeNull();
  });

  // Design decision: local auth state is always cleared regardless of API outcome.
  // The server cookie will expire on its own, and a network error should never
  // trap the user in a logged-in state with no way to re-authenticate.
  it('should navigate to login and clear state on API failure (intentional design)', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    const logoutFn = mock(() => Promise.reject(new Error('Server unreachable')));

    render(<LogoutButtonTestHarness logoutFn={logoutFn} />);

    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    // Despite the API failure, the user should be redirected and state cleared
    await waitFor(() => {
      expect(screen.getByText('Navigated to /login')).toBeTruthy();
    });
    expect(getCurrentUser()).toBeNull();
    expect(logoutFn).toHaveBeenCalledTimes(1);
  });

  it('should clear session filter mode from localStorage on logout', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    localStorage.setItem(STORAGE_KEY, 'mine');

    render(<LogoutButtonTestHarness logoutFn={async () => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /logout/i }));
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
