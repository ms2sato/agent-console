import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { installMockWebSocket } from '../../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../../lib/app-websocket';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { SessionTerminalRunContext, type SessionTerminalRun } from '../SessionTerminalRunContext';
import { TodoDetailDialog } from '../TodoDetailDialog';

const TERMINAL_BODY = 'Run it:\n\n```terminal\nbun run migrate\n```\n';
const USERS = [{ id: 'user-me', username: 'me' }];

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

function makeRun(): SessionTerminalRun {
  return {
    terminalWorkers: [{ id: 't1', name: 'Shell 1' }],
    activateWorker: mock(() => {}),
    createTerminalWorker: mock(async () => ({ id: 'new', name: 'Shell 2' })),
  };
}

async function renderDialog(todoId: string | null, run: SessionTerminalRun | null = null) {
  const onClose = mock(() => {});
  await renderWithRouter(
    <SessionTerminalRunContext.Provider value={run}>
      <TodoDetailDialog todoId={todoId} sessionId="session-1" users={USERS} onClose={onClose} />
    </SessionTerminalRunContext.Provider>,
  );
  return { onClose, user: userEvent.setup() };
}

/**
 * Mutations noted per test (each applied alone):
 *   - the dialog open regardless of `todoId` -> 'renders nothing and fetches nothing while closed'
 *   - `onOpenChange` not wired to `onClose` -> the Escape and close-control tests
 *   - `runEnabled` always false -> 'Run opens the confirmation ...'
 *   - `runEnabled` always true -> 'offers no Run without a terminal run context'
 *   - the "Open as page" params left out or pointing at another id -> 'Open as page links to ...'
 */
describe('TodoDetailDialog', () => {
  it('renders nothing and fetches nothing while closed', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1' })];

    await renderDialog(null);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.listFetches()).toHaveLength(0);
  });

  it('opens with the item\'s detail when todoId is set', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', title: 'Look closer', body: 'The long body text' })];

    await renderDialog('todo-1');

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Look closer')).toBeTruthy();
    expect(within(dialog).getByText('The long body text', { selector: 'p' })).toBeTruthy();
  });

  it('closes on Escape', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1' })];
    const { onClose, user } = await renderDialog('todo-1');
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes through the close control', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1' })];
    const { onClose, user } = await renderDialog('todo-1');
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Open as page links to the item\'s page', async () => {
    api.state.todos = [makeTodo({ id: 'todo-77' })];

    await renderDialog('todo-77');

    const link = await screen.findByRole('link', { name: 'Open as page' });
    expect(link.getAttribute('href')).toBe('/todos/todo-77');
  });

  it('a deleted item shows the deleted state inside the dialog', async () => {
    api.state.todos = [];

    await renderDialog('gone');

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('This Todo was deleted or does not exist')).toBeTruthy();
  });

  it('Run opens the confirmation with the command when the session provides terminals', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', body: TERMINAL_BODY })];
    const { user } = await renderDialog('todo-1', makeRun());

    await user.click(await screen.findByRole('button', { name: 'Run command in terminal' }));

    expect((await screen.findByTestId('run-command-text')).textContent).toBe('bun run migrate');
  });

  it('offers no Run without a terminal run context (Copy stays)', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', body: TERMINAL_BODY })];

    await renderDialog('todo-1', null);

    await screen.findByRole('button', { name: 'Copy code' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run command in terminal' })).toBeNull());
  });
});
