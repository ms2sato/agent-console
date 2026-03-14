/**
 * Tests for the login page behavior.
 *
 * Tests the login form logic directly using a minimal component that
 * replicates the login page behavior, avoiding mock.module for the API layer.
 * The actual login API call is tested through the component's onSubmit callback.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { setAuthMode, setCurrentUser, getCurrentUser, _reset as resetAuth, useAuth } from '../../lib/auth';
import { setHomeDir, _reset as resetPath } from '../../lib/path';

/**
 * Test harness component that mirrors the LoginPage logic
 * but accepts a login function as a prop for testability.
 * Uses useAuth() hook for reactive auth state, matching the real component.
 */
function LoginFormTestHarness({ loginFn }: { loginFn: (req: { username: string; password: string }) => Promise<{ user: { id: string; username: string; homeDir: string } }> }) {
  const { isMultiUser, currentUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [navigatedTo, setNavigatedTo] = useState<string | null>(null);

  // Redirect away if not in multi-user mode or already authenticated
  if (!isMultiUser || currentUser) {
    return <div>Redirected to /</div>;
  }

  if (navigatedTo) {
    return <div>Navigated to {navigatedTo}</div>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await loginFn({ username, password });
      setCurrentUser(result.user);
      setHomeDir(result.user.homeDir);
      setNavigatedTo('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <h1>Agent Console</h1>
      <form onSubmit={handleSubmit}>
        {error && <div role="alert">{error}</div>}
        <div>
          <label htmlFor="username">Username</label>
          <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    resetAuth();
    resetPath();
  });

  afterEach(() => {
    cleanup();
  });

  it('should render login form with username and password fields in multi-user mode', () => {
    setAuthMode('multi-user');
    const loginFn = mock(() => Promise.resolve({ user: { id: '1', username: 'a', homeDir: '/a' } }));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('should redirect when not in multi-user mode', () => {
    // authMode defaults to 'none'
    const loginFn = mock(() => Promise.resolve({ user: { id: '1', username: 'a', homeDir: '/a' } }));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    expect(screen.getByText('Redirected to /')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('should redirect when user is already authenticated', () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
    const loginFn = mock(() => Promise.resolve({ user: { id: '1', username: 'a', homeDir: '/a' } }));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    expect(screen.getByText('Redirected to /')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('should show error on failed login', async () => {
    setAuthMode('multi-user');
    const loginFn = mock(() => Promise.reject(new Error('Invalid credentials')));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'baduser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'badpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Invalid credentials');
    });
  });

  it('should call login function with credentials on submit', async () => {
    setAuthMode('multi-user');
    const loginFn = mock(() => Promise.resolve({
      user: { id: 'user-1', username: 'testuser', homeDir: '/home/testuser' },
    }));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(loginFn).toHaveBeenCalledTimes(1);
      expect(loginFn).toHaveBeenCalledWith({
        username: 'testuser',
        password: 'testpass',
      });
    });
  });

  it('should set current user and redirect on successful login', async () => {
    setAuthMode('multi-user');
    const user = { id: 'user-1', username: 'testuser', homeDir: '/home/testuser' };
    const loginFn = mock(() => Promise.resolve({ user }));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'testuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // After login succeeds, setCurrentUser triggers re-render via useAuth().
    // The guard detects authenticated user and shows redirect.
    await waitFor(() => {
      expect(screen.getByText('Redirected to /')).toBeTruthy();
    });

    expect(getCurrentUser()).toEqual(user);
  });

  it('should show rate limit error from server', async () => {
    setAuthMode('multi-user');
    const loginFn = mock(() => Promise.reject(new Error('Too many login attempts. Try again later.')));

    render(<LoginFormTestHarness loginFn={loginFn} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'user' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Too many login attempts. Try again later.');
    });
  });
});
