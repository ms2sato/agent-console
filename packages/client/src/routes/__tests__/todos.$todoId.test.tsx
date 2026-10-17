import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, act, within } from '@testing-library/react';
import { renderWithRouter } from '../../test/renderWithRouter';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { createTodoApiMock, makeTodo, makeTodoComment, makeTodoMove } from '../../test/todo-fixtures';
import { TodoDetailPage } from '../todos/$todoId/index';

const TERMINAL_BODY = 'Run it:\n\n```terminal\nbun run migrate\n```\n';

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

function detailFetches(id: string) {
  return api.listFetches().filter((call) => call.path === `/api/todos/${id}`);
}

/**
 * Mutations noted per test (each applied alone):
 *   - `runEnabled` passed as true on the page
 *     -> 'never offers Run, and offers Copy and Open in session for a terminal block'
 *   - a 404 rendered through the generic error path (the error rethrown)
 *     -> 'a deleted item shows the deleted-state card with a back link'
 *   - the detail query not invalidated on the frame -> 'a todos-updated frame refetches the item'
 */
describe('Todo detail page', () => {
  it('shows the item\'s title and body', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', title: 'Page title', body: 'Page body text' })];

    await renderWithRouter(<TodoDetailPage todoId="todo-1" />);

    expect(await screen.findByText('Page title', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText('Page body text', { selector: 'p' })).toBeTruthy();
  });

  it('hands the response\'s activities to the Thread, in the order sent', async () => {
    // Mutation: pass [] to TodoDetail on the page -> no activity rows, this test fails.
    api.state.todos = [makeTodo({ id: 'todo-1', commentCount: 1 })];
    api.state.activities['todo-1'] = [
      makeTodoMove({ id: 'm1', toSessionId: 'cccccccc-3333-4333-8333-333333333333' }),
      makeTodoComment({ id: 'c1', actor: { userId: 'user-me' }, text: 'Page reply' }),
    ];

    await renderWithRouter(<TodoDetailPage todoId="todo-1" />);

    const thread = await screen.findByRole('region', { name: 'Thread' });
    const rows = within(thread).getAllByTestId(/^todo-activity-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['todo-activity-m1', 'todo-activity-c1']);
    expect(within(thread).getByText('Page reply')).toBeTruthy();
  });

  it('keeps the page container full-width so a wide code block cannot widen the card', async () => {
    // Mutation: drop `w-full` from the page container -> this fails (the auto-margin flex item
    // would size to its widest descendant instead of the viewport).
    api.state.todos = [makeTodo({ id: 'todo-1', title: 'Page title', body: 'x' })];

    await renderWithRouter(<TodoDetailPage todoId="todo-1" />);

    const container = (await screen.findByTestId('todo-detail-todo-1')).closest('.card')?.parentElement;
    expect(container?.classList.contains('w-full')).toBe(true);
    expect(container?.classList.contains('max-w-4xl')).toBe(true);
  });

  it('a deleted item shows the deleted-state card with a back link', async () => {
    api.state.todos = [];

    await renderWithRouter(<TodoDetailPage todoId="gone" />);

    expect(await screen.findByText('This Todo was deleted or does not exist')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Todo' }).getAttribute('href')).toBe('/todos');
  });

  it('never offers Run, and offers Copy and Open in session for a terminal block', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', body: TERMINAL_BODY, sessionId: 'session-42' })];

    await renderWithRouter(<TodoDetailPage todoId="todo-1" />);

    await screen.findByRole('button', { name: 'Copy code' });
    expect(screen.queryByRole('button', { name: 'Run command in terminal' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in session' }).getAttribute('href')).toBe('/sessions/session-42');
  });

  it('a todos-updated frame refetches the item', async () => {
    api.state.todos = [makeTodo({ id: 'todo-1', title: 'Before' })];
    await renderWithRouter(<TodoDetailPage todoId="todo-1" />);
    await screen.findByText('Before', { selector: 'h2' });
    expect(detailFetches('todo-1')).toHaveLength(1);
    const ws = MockWebSocket.getLastInstance();
    if (!ws) throw new Error('Expected a MockWebSocket instance');
    act(() => {
      ws.simulateOpen();
    });
    api.state.todos = [makeTodo({ id: 'todo-1', title: 'After' })];

    await act(async () => {
      ws.simulateMessage(JSON.stringify({ type: 'todos-updated', sessionId: null }));
    });

    await waitFor(() => expect(detailFetches('todo-1')).toHaveLength(2));
    expect(await screen.findByText('After', { selector: 'h2' })).toBeTruthy();
  });
});
