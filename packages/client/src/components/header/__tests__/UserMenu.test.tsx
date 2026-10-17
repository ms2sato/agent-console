import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, within, waitFor } from '@testing-library/react';
import { userEvent, PointerEventsCheckLevel } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { jsonResponse, fetchUrl } from '../../../test/todo-fixtures';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { UserMenu } from '../UserMenu';

const originalFetch = globalThis.fetch;
const ME = { id: 'user-me', username: 'alice', homeDir: '/home/alice' };

let logoutRequests: number;

beforeEach(() => {
  resetAuth();
  auth.multiUser = false;
  logoutRequests = 0;
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL): Promise<Response> => {
      if (fetchUrl(input).includes('/auth/logout')) logoutRequests += 1;
      return jsonResponse({});
    }),
    { preconnect: () => {} },
  ) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetAuth();
});

const auth = { multiUser: false };

function asMultiUser() {
  auth.multiUser = true;
  setAuthMode('multi-user');
  setCurrentUser(ME);
}

async function renderMenu(path = '/') {
  const view = await renderWithRouter(<UserMenu />, path);
  return { ...view, user: userEvent.setup() };
}

/** Multi-user: named by the visible username. Single-user: named by its aria-label. */
function trigger() {
  return screen.getByRole('button', { name: auth.multiUser ? 'alice' : 'Account menu' });
}

function menu() {
  return screen.queryByRole('menu');
}

function itemLabels() {
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((el) => el.textContent);
}

describe('UserMenu trigger', () => {
  it('shows the username in multi-user mode', async () => {
    asMultiUser();
    await renderMenu();
    expect(trigger().textContent).toBe('alice');
    expect(trigger().getAttribute('aria-label')).toBeNull();
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
  });

  it('shows no username in single-user mode and is found by its label', async () => {
    await renderMenu();
    expect(trigger().textContent).toBe('');
    expect(trigger().getAttribute('aria-label')).toBe('Account menu');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
  });

  it('is active when the path matches any menu item, inactive otherwise', async () => {
    await renderMenu('/settings/repositories/abc');
    expect(trigger().className).toContain('text-white');
    expect(trigger().className).toContain('bg-white/10');
    cleanup();

    await renderMenu('/todos');
    expect(trigger().className).toContain('text-slate-400');
    expect(trigger().className).not.toContain('bg-white/10');
  });
});

describe('UserMenu opening and closing', () => {
  it('opens on click', async () => {
    const { user } = await renderMenu();
    expect(menu()).toBeNull();
    await user.click(trigger());
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('opens on Enter', async () => {
    const { user } = await renderMenu();
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('opens on Space', async () => {
    const { user } = await renderMenu();
    trigger().focus();
    await user.keyboard(' ');
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('opens on ArrowDown', async () => {
    const { user } = await renderMenu();
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { user } = await renderMenu();
    await user.click(trigger());
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');

    await waitForAbsent(() => menu());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('closes on a pointer click outside', async () => {
    const { user } = await renderMenu();
    await user.click(trigger());
    await screen.findByRole('menu');

    // While open, Radix sets `pointer-events: none` on <body> (so a real browser routes the
    // outside press to the dismissable layer). user-event's own guard refuses to press such an
    // element, so for this one press the guard is turned off; the pointerdown is still dispatched.
    await userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never }).click(document.body);

    await waitForAbsent(() => menu());
  });
});

describe('UserMenu contents', () => {
  it('lists the menu group, a username heading and Logout in multi-user mode', async () => {
    asMultiUser();
    const { user } = await renderMenu();
    await user.click(trigger());
    await screen.findByRole('menu');

    expect(itemLabels()).toEqual(['Settings', 'Repositories', 'Agents', 'Jobs', 'Shared accounts', 'Logout']);
    const heading = within(screen.getByRole('menu')).getByText('alice');
    expect(heading).toBeTruthy();
    expect(within(screen.getByRole('menu')).getAllByRole('separator').length).toBeGreaterThan(0);
  });

  it('lists only the destinations, with no heading and no Logout, in single-user mode', async () => {
    const { user } = await renderMenu();
    await user.click(trigger());
    await screen.findByRole('menu');

    expect(itemLabels()).toEqual(['Settings', 'Repositories', 'Agents', 'Jobs']);
    expect(within(screen.getByRole('menu')).queryByText('Logout')).toBeNull();
    expect(within(screen.getByRole('menu')).queryByText('Shared accounts')).toBeNull();
  });

  it('links each destination to its page', async () => {
    asMultiUser();
    const { user } = await renderMenu();
    await user.click(trigger());
    const links = within(await screen.findByRole('menu')).getAllByRole('menuitem').filter((el) => el.tagName === 'A');

    expect(links.map((el) => [el.textContent, el.getAttribute('href')])).toEqual([
      ['Settings', '/settings'],
      ['Repositories', '/settings/repositories'],
      ['Agents', '/agents'],
      ['Jobs', '/jobs'],
      ['Shared accounts', '/settings/shared-accounts'],
    ]);
  });

  it('highlights only the item matching the current path', async () => {
    const { user } = await renderMenu('/settings/repositories/abc');
    await user.click(trigger());
    await screen.findByRole('menu');

    const highlighted = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .filter((el) => el.className.includes('bg-white/10'))
      .map((el) => el.textContent);
    expect(highlighted).toEqual(['Repositories']);
  });

  it('calls the logout API when Logout is selected', async () => {
    asMultiUser();
    const { user } = await renderMenu();
    await user.click(trigger());
    await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));

    await waitFor(() => expect(logoutRequests).toBe(1));
  });
});
