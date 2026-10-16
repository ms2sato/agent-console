import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { TodosPage } from '../TodosPage';

const ME = { id: 'user-me', username: 'me' };
const BOB = { id: 'user-bob', username: 'bob' };

let api: ReturnType<typeof createTodoApiMock>;
let restoreFetch: () => void;
let restoreWebSocket: () => void;

beforeEach(() => {
  api = createTodoApiMock();
  restoreFetch = api.install();
  resetAuth();
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
});

afterEach(() => {
  cleanup();
  restoreFetch();
  restoreWebSocket();
});

async function renderPage() {
  const rendered = await renderWithRouter(<TodosPage />);
  return { ...rendered, user: userEvent.setup() };
}

function lastListSearch(): URLSearchParams {
  const fetches = api.listFetches();
  const last = fetches[fetches.length - 1];
  if (!last) throw new Error('No list fetch was recorded');
  return last.search;
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone,
 * every to-do test file re-run, production file restored after):
 *
 *   default status filter not 'open' (TodosPage.tsx DEFAULT_STATUS_FILTER)
 *     -> here, alone: 'fetches the open items by default'
 *   assignee control not hidden at one user (TodoRow.tsx)
 *     -> here: 'hides the per-row assignee control when the directory has one user'
 *   session-deleted not wired (useFilteredTodos.ts)
 *     -> here: 'refetches when a session-deleted frame arrives'
 *   a todos-updated frame with a null sessionId ignored (useFilteredTodos.ts)
 *     -> here: 'refetches when a todos-updated frame arrives'
 *   a question resolve allowed with empty text (TodoRow.tsx)
 *     -> here: 'a question cannot be resolved without text (nothing is sent)'
 */
describe('TodosPage', () => {
  describe('list', () => {
    it('fetches the open items by default', async () => {
      await renderPage();

      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(0));
      expect(lastListSearch().get('status')).toBe('open');
      expect((screen.getByLabelText('Status filter') as HTMLSelectElement).value).toBe('open');
    });

    it('renders each item with its title and badges', async () => {
      api.state.todos = [
        makeTodo({ id: 'a', title: 'First', kind: 'action', scope: 'global', sessionId: null }),
        makeTodo({ id: 'b', title: 'Second', kind: 'question', scope: 'session' }),
      ];
      await renderPage();

      await waitFor(() => expect(screen.getByText('First')).toBeTruthy());
      expect(screen.getByText('Second')).toBeTruthy();
      expect(screen.getByLabelText('Kind: question')).toBeTruthy();
      expect(screen.getByLabelText('Scope: global')).toBeTruthy();
    });

    it('shows the empty state', async () => {
      await renderPage();

      await waitFor(() => expect(screen.getByText('No Todo items found')).toBeTruthy());
    });

    it('shows an error state when the list cannot be fetched', async () => {
      // A list entry that fails the strict wire parse.
      api.state.todos = [{ bad: true } as never];
      await renderPage();

      await waitFor(() => expect(screen.getByText('Failed to load Todo items')).toBeTruthy());
    });
  });

  describe('filters', () => {
    it('the status filter refetches with the chosen status, and "All" sends none', async () => {
      const { user } = await renderPage();
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(0));

      await user.selectOptions(screen.getByLabelText('Status filter'), 'done');
      await waitFor(() => expect(lastListSearch().get('status')).toBe('done'));

      await user.selectOptions(screen.getByLabelText('Status filter'), 'all');
      await waitFor(() => expect(lastListSearch().has('status')).toBe(false));
    });

    it('a concrete assignee is sent to the server', async () => {
      api.state.users = [ME, BOB];
      const { user } = await renderPage();
      await waitFor(() => expect(within(screen.getByLabelText('Assignee filter')).getByRole('option', { name: 'bob' })).toBeTruthy());

      await user.selectOptions(screen.getByLabelText('Assignee filter'), BOB.id);

      await waitFor(() => expect(lastListSearch().get('assignee')).toBe(BOB.id));
    });

    it('"Me" sends the current user id', async () => {
      setCurrentUser({ ...ME, homeDir: '/home/me' });
      api.state.users = [ME, BOB];
      const { user } = await renderPage();

      await user.selectOptions(screen.getByLabelText('Assignee filter'), 'Me');

      await waitFor(() => expect(lastListSearch().get('assignee')).toBe(ME.id));
    });

    it('offers no "Me" option without a current user (single-user mode)', async () => {
      await renderPage();

      expect(screen.queryByRole('option', { name: 'Me' })).toBeNull();
    });

    it('"Unassigned" narrows the list to items without an assignee', async () => {
      api.state.todos = [
        makeTodo({ id: 'a', title: 'Nobody has this', assigneeUserId: null }),
        makeTodo({ id: 'b', title: 'Bob has this', assigneeUserId: BOB.id }),
      ];
      api.state.users = [ME, BOB];
      const { user } = await renderPage();
      await waitFor(() => expect(screen.getByText('Bob has this')).toBeTruthy());

      await user.selectOptions(screen.getByLabelText('Assignee filter'), 'unassigned');

      await waitForAbsent(() => screen.queryByText('Bob has this'));
      expect(screen.getByText('Nobody has this')).toBeTruthy();
      expect(lastListSearch().has('assignee')).toBe(false);
    });

    it('the session filter lists the sessions in the list and narrows to the chosen one', async () => {
      api.state.todos = [
        makeTodo({ id: 'a', title: 'In alpha', sessionId: 'alpha-session-id' }),
        makeTodo({ id: 'b', title: 'In beta', sessionId: 'beta-session-id' }),
        makeTodo({ id: 'c', title: 'Sessionless', scope: 'global', sessionId: null }),
      ];
      const { user } = await renderPage();
      await waitFor(() => expect(screen.getByText('In alpha')).toBeTruthy());

      await user.selectOptions(screen.getByLabelText('Session filter'), 'alpha-session-id');

      await waitForAbsent(() => screen.queryByText('In beta'));
      expect(screen.getByText('In alpha')).toBeTruthy();
      expect(screen.queryByText('Sessionless')).toBeNull();
    });
  });

  describe('add', () => {
    it('adds an item and refetches the list', async () => {
      const { user } = await renderPage();
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(0));
      const fetchesBefore = api.listFetches().length;

      await user.type(screen.getByLabelText('Title'), 'Write the release notes');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/api/todos' });
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(fetchesBefore));
    });
  });

  describe('actions refetch the list', () => {
    it('resolving an action refetches the list', async () => {
      api.state.todos = [makeTodo({ id: 'a', title: 'Resolve me', kind: 'action' })];
      const { user } = await renderPage();
      await waitFor(() => expect(screen.getByText('Resolve me')).toBeTruthy());
      const fetchesBefore = api.listFetches().length;

      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(fetchesBefore));
    });

    it('a question cannot be resolved without text (nothing is sent)', async () => {
      api.state.todos = [makeTodo({ id: 'q', title: 'Which one?', kind: 'question' })];
      const { user } = await renderPage();
      await waitFor(() => expect(screen.getByText('Which one?')).toBeTruthy());

      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      expect(api.writes()).toHaveLength(0);
    });

    it('dismissing an item refetches the list', async () => {
      api.state.todos = [makeTodo({ id: 'a', title: 'Dismiss me' })];
      const { user } = await renderPage();
      await waitFor(() => expect(screen.getByText('Dismiss me')).toBeTruthy());
      const fetchesBefore = api.listFetches().length;

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(api.writes()[0]?.path).toBe('/api/todos/a/dismiss'));
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(fetchesBefore));
    });

    it('rows carry no body, edit, re-scope or delete controls (those live in the detail view)', async () => {
      api.state.todos = [makeTodo({ id: 'a', title: 'Summary only', body: 'The long body text' })];
      await renderPage();
      await waitFor(() => expect(screen.getByText('Summary only')).toBeTruthy());

      expect(screen.queryByText('The long body text')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Make global' })).toBeNull();
    });
  });

  describe('open detail', () => {
    it('Open navigates to the item\'s detail page', async () => {
      api.state.todos = [makeTodo({ id: 'todo-42', title: 'Open me' })];
      const { user, router } = await renderPage();
      await waitFor(() => expect(screen.getByText('Open me')).toBeTruthy());

      await user.click(screen.getByRole('button', { name: 'Open Open me' }));

      // Mutation: an onOpenDetail that navigates elsewhere (or nowhere) fails this.
      await waitFor(() => expect(router.state.location.pathname).toBe('/todos/todo-42'));
    });
  });

  describe('assign', () => {
    it('hides the per-row assignee control when the directory has one user', async () => {
      api.state.users = [ME];
      api.state.todos = [makeTodo({ id: 'a', title: 'Solo task' })];
      await renderPage();
      await waitFor(() => expect(screen.getByText('Solo task')).toBeTruthy());
      // The user directory has loaded once the filter lists its member.
      await waitFor(() => expect(screen.getByRole('option', { name: 'me' })).toBeTruthy());

      expect(screen.queryByLabelText('Assignee for Solo task')).toBeNull();
    });

    it('shows the per-row assignee control when the directory has several users', async () => {
      api.state.users = [ME, BOB];
      api.state.todos = [makeTodo({ id: 'a', title: 'Team task' })];
      await renderPage();

      await waitFor(() => expect(screen.getByLabelText('Assignee for Team task')).toBeTruthy());
    });
  });

  describe('realtime', () => {
    it('refetches when a todos-updated frame arrives', async () => {
      await renderPage();
      await waitFor(() => expect(api.listFetches().length).toBeGreaterThan(0));
      const ws = MockWebSocket.getLastInstance();
      if (!ws) throw new Error('Expected a MockWebSocket instance');
      act(() => {
        ws.simulateOpen();
      });
      api.state.todos = [makeTodo({ id: 'new', title: 'Arrived live' })];

      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
      });

      await waitFor(() => expect(screen.getByText('Arrived live')).toBeTruthy());
    });

    it('refetches when a session-deleted frame arrives', async () => {
      api.state.todos = [makeTodo({ id: 'a', title: 'Doomed with its session' })];
      await renderPage();
      await waitFor(() => expect(screen.getByText('Doomed with its session')).toBeTruthy());
      const ws = MockWebSocket.getLastInstance();
      if (!ws) throw new Error('Expected a MockWebSocket instance');
      act(() => {
        ws.simulateOpen();
      });
      api.state.todos = [];

      await act(async () => {
        ws.simulateMessage(JSON.stringify({ type: 'session-deleted', sessionId: 'session-1' }));
      });

      await waitForAbsent(() => screen.queryByText('Doomed with its session'));
    });
  });
});
