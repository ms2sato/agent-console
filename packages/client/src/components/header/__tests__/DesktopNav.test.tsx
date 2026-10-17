import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { completeWireBody } from '../../../test/wire-fixtures';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { makeTodo, jsonResponse, fetchUrl } from '../../../test/todo-fixtures';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { DesktopNav } from '../DesktopNav';
import { navItemsByPlacement } from '../nav-items';

const originalFetch = globalThis.fetch;
const ME = { id: 'user-me', username: 'alice', homeDir: '/home/alice' };

let restoreWebSocket: () => void;

beforeEach(() => {
  resetAuth();
  setAuthMode('multi-user');
  setCurrentUser(ME);
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL): Promise<Response> => {
      const url = fetchUrl(input);
      if (url.includes('/api/todos')) {
        return jsonResponse({ todos: [makeTodo({ id: 'a', assigneeUserId: ME.id }), makeTodo({ id: 'b', assigneeUserId: ME.id })] });
      }
      if (url.includes('/review-queue')) {
        return jsonResponse(
          completeWireBody([
            { sourceSessionId: 's1', sourceSessionTitle: 'S1', items: [{ workerId: 'w1' }, { workerId: 'w2' }, { workerId: 'w3' }] },
          ]),
        );
      }
      if (url.includes('/sessions/validate')) {
        return jsonResponse(completeWireBody({ hasIssues: true, results: [{ sessionId: 's1', valid: false }] }));
      }
      if (url.includes('/notifications')) {
        return jsonResponse({ items: [], lastSeenAt: null, unreadCount: 0 });
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
});

async function renderNav(isMobile = false, onCreateWorktree: () => void = () => {}) {
  const view = await renderWithRouter(
    <DesktopNav onCreateWorktree={onCreateWorktree} isMobile={isMobile} />,
  );
  return { ...view, user: userEvent.setup() };
}

function plusButton() {
  return screen.getByRole('button', { name: 'Create worktree' });
}
function maintenanceLink() {
  return screen.getByRole('link', { name: '1' });
}
function todoLink() {
  return screen.getByRole('link', { name: /^Todo/ });
}
function reviewLink() {
  return screen.getByRole('link', { name: /^Review/ });
}
function artifactsLink() {
  return screen.getByRole('link', { name: 'Artifacts' });
}
function bellButton() {
  return screen.getByRole('button', { name: /notifications/i });
}
function accountTrigger() {
  // Multi-user (the beforeEach default): named by the visible username.
  return screen.getByRole('button', { name: 'alice' });
}

describe('DesktopNav', () => {
  it('renders exactly the top-level controls, in order: +, maintenance, Todo, Review, Artifacts, bell, user menu', async () => {
    const { container } = await renderNav();
    await waitFor(() => expect(maintenanceLink()).toBeTruthy());

    const expected = [plusButton(), maintenanceLink(), todoLink(), reviewLink(), artifactsLink(), bellButton(), accountTrigger()];
    const actual = Array.from(container.querySelectorAll('a, button'));

    expect(actual.length).toBe(expected.length);
    expected.forEach((el, index) => {
      expect(actual[index] === el).toBe(true);
    });
  });

  it('keeps the destinations that moved into the user menu out of the top level', async () => {
    await renderNav();
    for (const label of ['Settings', 'Repositories', 'Agents', 'Jobs', 'Shared accounts', 'Logout']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('does not mount the notification bell when isMobile is true', async () => {
    const { container } = await renderNav(true);
    expect(screen.queryByRole('button', { name: /notifications/i })).toBeNull();
    expect(container.querySelectorAll('a, button').length).toBeGreaterThan(0);
    expect(accountTrigger()).toBeTruthy();
  });

  it('calls onCreateWorktree from the + button', async () => {
    const onCreateWorktree = mock(() => {});
    const { user } = await renderNav(false, onCreateWorktree);
    await user.click(plusButton());
    expect(onCreateWorktree).toHaveBeenCalledTimes(1);
  });

  it('keeps the Todo and Review badges rendered while the user menu is open', async () => {
    const { user } = await renderNav();
    await waitFor(() => expect(todoLink().textContent).toContain('2'));
    await waitFor(() => expect(reviewLink().textContent).toContain('3'));

    await user.click(accountTrigger());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThan(0);

    // An open Radix menu marks everything outside it aria-hidden, so the lookups opt in to hidden nodes.
    expect(screen.getByRole('link', { name: /^Todo/, hidden: true }).textContent).toContain('2');
    expect(screen.getByRole('link', { name: /^Review/, hidden: true }).textContent).toContain('3');
  });

  describe.each([
    ['single-user', false],
    ['multi-user', true],
  ])('parity with NAV_ITEMS (%s)', (_label, multiUser) => {
    it('renders a link for every top-placement item visible in that mode, and no other destination', async () => {
      if (!multiUser) {
        resetAuth();
      }
      const { container } = await renderNav();
      await waitFor(() => expect(maintenanceLink()).toBeTruthy());

      const hrefs = Array.from(container.querySelectorAll('a'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((href) => href !== '/maintenance');
      expect(hrefs).toEqual(navItemsByPlacement('top', multiUser).map((i) => i.to));
    });
  });
});
