import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { CreatorBadge } from '../CreatorBadge';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../../lib/auth';

// Reach, measured (control: all cases green): inverting the self/others colour
// rule fails the mine and others cases; dropping the multi-user gate fails the
// single-user case; dropping the username gate fails the no-username cases.

const SELF = { id: 'self-uuid', username: 'me', homeDir: '/home/me' };

describe('CreatorBadge', () => {
  afterEach(() => {
    cleanup();
    resetAuth();
  });

  it('renders nothing in single-user mode, even with an owner username', () => {
    // authMode defaults to 'none' from resetAuth(); do NOT call setAuthMode here
    render(<CreatorBadge createdBy="self-uuid" createdByUsername="me" />);
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });

  it('shows the username in the "mine" colour when the owner is the current user (matched by UUID)', () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    render(<CreatorBadge createdBy="self-uuid" createdByUsername="me" />);
    const badge = screen.getByTestId('session-creator-username');
    expect(badge.textContent).toBe('me');
    expect(badge.getAttribute('title')).toBe('me');
    expect(badge.className).toContain('bg-indigo-500/20 text-indigo-200');
    expect(badge.className).not.toContain('amber');
  });

  it('uses the "others" colour for another user\'s session, even when the usernames are equal (UUID decides, not the name)', () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    render(<CreatorBadge createdBy="someone-else-uuid" createdByUsername="me" />);
    const badge = screen.getByTestId('session-creator-username');
    expect(badge.className).toContain('bg-amber-500/20 text-amber-200');
    expect(badge.className).not.toContain('indigo');
  });

  it('uses the "others" colour when the current user is not loaded yet or the session has no createdBy', () => {
    setAuthMode('multi-user');
    setCurrentUser(null);
    const { rerender } = render(<CreatorBadge createdBy="self-uuid" createdByUsername="alice" />);
    expect(screen.getByTestId('session-creator-username').className).toContain('amber');

    setCurrentUser(SELF);
    rerender(<CreatorBadge createdByUsername="alice" />);
    expect(screen.getByTestId('session-creator-username').className).toContain('amber');
  });

  it.each([[null], [undefined], ['']])('renders nothing when the owner username is %p (legacy / ownerless session)', (createdByUsername) => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    render(<CreatorBadge createdBy="self-uuid" createdByUsername={createdByUsername} />);
    expect(screen.queryByTestId('session-creator-username')).toBeNull();
  });

  it('prepends the call site\'s positioning classes and otherwise keeps the exact badge classes (the sidebar corner pin)', () => {
    setAuthMode('multi-user');
    setCurrentUser(SELF);
    render(<CreatorBadge createdBy="x" createdByUsername="alice" positionClassName="absolute top-2 right-2" />);
    expect(screen.getByTestId('session-creator-username').className).toBe(
      'absolute top-2 right-2 max-w-[6rem] truncate text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200',
    );
  });

  it('without a positioning class the badge is inline (no leading space, no absolute pin)', () => {
    setAuthMode('multi-user');
    render(<CreatorBadge createdBy="x" createdByUsername="alice" />);
    expect(screen.getByTestId('session-creator-username').className).toBe(
      'max-w-[6rem] truncate text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200',
    );
  });
});
