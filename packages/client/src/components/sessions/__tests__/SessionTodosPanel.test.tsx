import { useState } from 'react';
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionDataProvider } from '../../../test/session-data';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { SessionTodosPanel } from '../SessionTodosPanel';
import { waitForAbsent } from '../../../test/waitForAbsent';

const ME = { id: 'user-me', username: 'me' };
const BOB = { id: 'user-bob', username: 'bob' };

let api: ReturnType<typeof createTodoApiMock>;
let restoreFetch: () => void;
let restoreWebSocket: () => void;

beforeEach(() => {
  api = createTodoApiMock();
  restoreFetch = api.install();
  restoreWebSocket = installMockWebSocket();
  resetWebSocket();
});

afterEach(() => {
  cleanup();
  restoreFetch();
  restoreWebSocket();
});

async function renderPanel(props: { isExpanded?: boolean; compact?: boolean; onToggle?: () => void } = {}) {
  const rendered = await renderWithRouter(
    <SessionDataProvider>
      <div data-testid="terminal-host">
        <SessionTodosPanel
          sessionId="session-1"
          isExpanded={props.isExpanded ?? true}
          onToggleExpanded={props.onToggle ?? (() => {})}
          compact={props.compact ?? false}
        />
      </div>
    </SessionDataProvider>,
  );
  return { ...rendered, user: userEvent.setup() };
}

/**
 * Mutations noted per test (each applied alone):
 *   - `openCount` counts every item (hooks/useSessionTodos.ts)
 *     -> 'counts only open items in the header ...'
 *   - the panel renders before the first fetch settles (the isPending return removed)
 *     -> 'renders nothing while the list is pending'
 *   - the add form sends the global default instead of the session scope
 *     -> 'adds with the session preset and the session scope ...'
 *   - the session field shown in the sidebar form -> 'the add form hides the session field ...'
 *   - the rows render the body -> 'rows are summaries ...'
 *   - the `tabIndex` dropped from one control type (the Open button, the assignee select, the
 *     add-form controls, resolve/dismiss) -> 'excludes every control of the body from the tab order ...'
 *   - the header always shows the count, or the error line / Retry dropped
 *     -> 'a failed list fetch shows ...'
 *   - the panel replaced by the dialog while one is open
 *     -> 'opening the detail leaves the surrounding markup mounted'
 */
describe('SessionTodosPanel', () => {
  it('renders nothing while the list is pending', async () => {
    api.fetchMock.mockImplementation(() => new Promise(() => {}));

    await renderPanel();

    expect(screen.queryByLabelText('Collapse Todo')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add Todo' })).toBeNull();
  });

  it('with zero items renders "Todo (0)" and the add form', async () => {
    await renderPanel();

    expect(await screen.findByText('Todo (0)')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Add Todo' })).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('counts only open items in the header while listing every item', async () => {
    api.state.todos = [
      makeTodo({ id: 'a', title: 'Open one' }),
      makeTodo({ id: 'b', title: 'Done one', status: 'done', resolutionText: 'ok' }),
      makeTodo({ id: 'c', title: 'Open global', scope: 'global' }),
    ];

    await renderPanel();

    expect(await screen.findByText('Todo (2)')).toBeTruthy();
    expect(screen.getByText('Open one')).toBeTruthy();
    expect(screen.getByText('Done one')).toBeTruthy();
    expect(screen.getByText('Open global')).toBeTruthy();
  });

  it('collapses through the header toggle', async () => {
    api.state.todos = [makeTodo()];
    const onToggle = mock(() => {});

    await renderPanel({ onToggle });

    fireEvent.click(await screen.findByLabelText('Collapse Todo'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows only a labelled rail button with the open count in compact mode', async () => {
    api.state.todos = [makeTodo()];

    await renderPanel({ compact: true });

    expect(await screen.findByLabelText('Expand Todo')).toBeTruthy();
    expect(screen.getByText('Todo (1)')).toBeTruthy();
    expect(screen.queryByText('Run the migration')).toBeNull();
  });

  it('compact mode at zero open items still shows the rail button with (0)', async () => {
    api.state.todos = [makeTodo({ status: 'done', resolutionText: 'x' })];

    await renderPanel({ compact: true });

    expect(await screen.findByText('Todo (0)')).toBeTruthy();
  });

  it('a failed list fetch shows "Todo" without a count, the error line, Retry and the add form; Retry refetches', async () => {
    let listCalls = 0;
    const original = api.fetchMock.getMockImplementation();
    api.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      if (url.pathname === '/api/todos') {
        listCalls += 1;
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return original!(input, init);
    });
    const { user } = await renderPanel();

    expect(await screen.findByText('Failed to load Todo items')).toBeTruthy();
    expect(screen.getByLabelText('Collapse Todo').textContent).toBe('Todo');
    expect(screen.queryByText(/Todo \(/)).toBeNull();
    expect(screen.getByRole('form', { name: 'Add Todo' })).toBeTruthy();
    const callsBefore = listCalls;

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(listCalls).toBe(callsBefore + 1));
  });

  it('a failed list fetch in compact mode labels the rail button "Todo" without a count', async () => {
    api.fetchMock.mockImplementation(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));

    await renderPanel({ compact: true });

    const rail = await screen.findByLabelText('Expand Todo');
    expect(rail.textContent).toBe('Todo');
  });

  it('excludes every control of the body from the tab order while collapsed, and restores them when expanded', async () => {
    api.state.users = [ME, BOB];
    api.state.todos = [makeTodo({ id: 'a', title: 'Open one' })];

    function Host() {
      const [expanded, setExpanded] = useState(false);
      return (
        <SessionTodosPanel
          sessionId="session-1"
          isExpanded={expanded}
          onToggleExpanded={() => setExpanded((value) => !value)}
          compact={false}
        />
      );
    }
    await renderWithRouter(
      <SessionDataProvider>
        <Host />
      </SessionDataProvider>,
    );
    const row = await screen.findByTestId('todo-a');
    const body = row.closest('.max-h-96') as HTMLElement;
    // Wait for the directory so the assignee select is part of the body.
    await waitFor(() => expect(screen.getByLabelText('Assignee for Open one')).toBeTruthy());

    const named = [
      screen.getByLabelText('Kind'),
      screen.getByLabelText('Title'),
      screen.getByLabelText('Body'),
      within(screen.getByRole('form', { name: 'Add Todo', hidden: true })).getByLabelText('Assignee'),
      screen.getByRole('button', { name: 'Add', hidden: true }),
      screen.getByLabelText('Open Open one'),
      screen.getByLabelText('Resolution text for Open one'),
      screen.getByRole('button', { name: 'Resolve', hidden: true }),
      screen.getByRole('button', { name: 'Dismiss', hidden: true }),
      screen.getByLabelText('Assignee for Open one'),
    ];
    const everyControl = Array.from(body.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]'));
    expect(everyControl.length).toBe(named.length);
    for (const control of everyControl) {
      expect(control.getAttribute('tabindex')).toBe('-1');
    }

    fireEvent.click(screen.getByLabelText('Expand Todo'));
    await waitFor(() => expect(screen.getByLabelText('Collapse Todo')).toBeTruthy());
    for (const control of everyControl) {
      expect(control.getAttribute('tabindex')).toBeNull();
    }
  });

  it('the Retry control is excluded from the tab order while collapsed', async () => {
    api.fetchMock.mockImplementation(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));

    await renderPanel({ isExpanded: false });

    const retry = await screen.findByRole('button', { name: 'Retry', hidden: true });
    expect(retry.getAttribute('tabindex')).toBe('-1');
  });

  describe('add form', () => {
    it('hides the session field and the scope choice (the session is preset)', async () => {
      await renderPanel();

      await screen.findByRole('form', { name: 'Add Todo' });
      expect(screen.queryByLabelText('Session id')).toBeNull();
      expect(screen.queryByLabelText('Scope')).toBeNull();
      expect(screen.getByLabelText('Kind')).toBeTruthy();
    });

    it('adds with the session preset and the session scope (not the global default)', async () => {
      const { user } = await renderPanel();

      await user.type(await screen.findByLabelText('Title'), 'Check the rollout');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/api/todos' });
      expect(api.writes()[0]?.body).toMatchObject({ sessionId: 'session-1', scope: 'session', title: 'Check the rollout' });
    });

    it('offers the assignee select only when the directory has several users', async () => {
      api.state.users = [ME];
      await renderPanel();
      await screen.findByLabelText('Title');
      await waitFor(() => expect(api.fetchMock.mock.calls.length).toBeGreaterThan(1));
      expect(screen.queryByLabelText('Assignee')).toBeNull();
      cleanup();

      api.state.users = [ME, BOB];
      await renderPanel();
      expect(await screen.findByLabelText('Assignee')).toBeTruthy();
    });
  });

  describe('rows', () => {
    it('are summaries with resolve, dismiss and assignee controls, and no body or delete', async () => {
      api.state.users = [ME, BOB];
      api.state.todos = [makeTodo({ id: 'a', title: 'Row one', body: 'Long body text' })];

      await renderPanel();

      await screen.findByText('Row one');
      expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
      expect(await screen.findByLabelText('Assignee for Row one')).toBeTruthy();
      expect(screen.queryByText('Long body text')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(screen.queryByText('Open session')).toBeNull();
    });

    it('a refused action is shown in an error dialog', async () => {
      api.state.refusal = { status: 409, error: 'The item is no longer open' };
      api.state.todos = [makeTodo({ id: 'a', title: 'Raced one' })];
      const { user } = await renderPanel();

      await user.click(await screen.findByRole('button', { name: 'Dismiss' }));

      expect(await screen.findByText('The item is no longer open')).toBeTruthy();
    });
  });

  describe('detail dialog', () => {
    it('Open shows the item\'s detail and leaves the surrounding markup mounted', async () => {
      api.state.todos = [makeTodo({ id: 'todo-9', title: 'Look closer', body: 'The long body text' })];
      const { user } = await renderPanel();

      await user.click(await screen.findByRole('button', { name: 'Open Look closer' }));

      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(await screen.findByText('The long body text', { selector: 'p' })).toBeTruthy();
      // The panel itself stays mounted under the dialog (its header is still there).
      expect(screen.getByText('Todo (1)')).toBeTruthy();
      expect(document.body.contains(screen.getByTestId('terminal-host'))).toBe(true);
    });

    it('closes through the dialog close control', async () => {
      api.state.todos = [makeTodo({ id: 'todo-9', title: 'Look closer' })];
      const { user } = await renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Open Look closer' }));
      await screen.findByRole('dialog');

      await user.keyboard('{Escape}');

      await waitForAbsent(() => screen.queryByRole('dialog'));
      expect(screen.getByTestId('terminal-host')).toBeTruthy();
    });

    it('Escape returns focus to the Open button that opened the dialog', async () => {
      api.state.todos = [makeTodo({ id: 'todo-9', title: 'Look closer' })];
      const { user } = await renderPanel();
      const opener = await screen.findByRole('button', { name: 'Open Look closer' });
      await user.click(opener);
      await screen.findByRole('dialog');

      await user.keyboard('{Escape}');

      await waitForAbsent(() => screen.queryByRole('dialog'));
      await waitFor(() => expect(document.activeElement === opener).toBe(true));
    });

    it('after deleting from the detail, focus stays inside the panel (not on the body)', async () => {
      api.state.todos = [makeTodo({ id: 'todo-9', title: 'Doomed' })];
      const { user } = await renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Open Doomed' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(await within(dialog).findByRole('button', { name: 'Delete' }));
      const confirm = await screen.findByRole('alertdialog');
      api.state.todos = [];
      await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

      await waitForAbsent(() => screen.queryByRole('dialog'));
      await waitForAbsent(() => screen.queryByText('Doomed'));
      // The row that opened the dialog is gone, so focus lands on the add form's title input.
      const titleInput = screen.getByLabelText('Title');
      await waitFor(() => expect(document.activeElement === titleInput).toBe(true));
    });
  });
});
