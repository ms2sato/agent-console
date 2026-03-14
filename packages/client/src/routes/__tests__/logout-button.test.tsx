/**
 * Tests for the LogoutButton behavior.
 *
 * Uses a test harness that replicates the LogoutButton logic,
 * testing the auth state transitions and loading state.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { setAuthMode, setCurrentUser, getCurrentUser, _reset as resetAuth, useAuth } from '../../lib/auth';

/**
 * Test harness that mirrors LogoutButton logic with an injectable logout function.
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

    // Resolve the logout to complete
    resolveLogout!();
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
});
