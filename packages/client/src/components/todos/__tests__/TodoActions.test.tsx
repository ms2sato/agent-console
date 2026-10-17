import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { TodoActions } from '../TodoActions';

const ME = { id: 'user-me', username: 'me' };
const BOB = { id: 'user-bob', username: 'bob' };

let api: ReturnType<typeof createTodoApiMock>;
let restoreFetch: () => void;

beforeEach(() => {
  api = createTodoApiMock();
  restoreFetch = api.install();
});

afterEach(() => {
  cleanup();
  restoreFetch();
});

async function renderActions(overrides: Parameters<typeof makeTodo>[0] = {}, users = [ME]) {
  const todo = makeTodo(overrides);
  api.state.todos = [todo];
  const onError = mock((_title: string, _message: string) => {});
  await renderWithRouter(<TodoActions todo={todo} users={users} onError={onError} />);
  return { todo, onError, user: userEvent.setup() };
}

/**
 * Measured reach, recorded by WHICH test failed (mutation applied alone to
 * TodoActions.tsx, this file re-run, production file restored after):
 *
 *   the resolve text dropped from the POST body (`resolveTodo(todo.id, undefined)`)
 *     -> here: 'resolves with the text typed into the resolution box'
 *        (the no-text case 'resolves an action without text, sending an empty body' still passes, as it should)
 */
describe('TodoActions', () => {
  describe('resolve', () => {
    it('resolves with the text typed into the resolution box', async () => {
      const { todo, user } = await renderActions({ kind: 'action' });

      await user.type(screen.getByLabelText(`Resolution text for ${todo.title}`), 'Done by hand');
      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({
        method: 'POST',
        path: `/api/todos/${todo.id}/resolve`,
        body: { text: 'Done by hand' },
      });
    });

    it('resolves an action without text, sending an empty body', async () => {
      const { todo, user } = await renderActions({ kind: 'action' });

      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/api/todos/${todo.id}/resolve`, body: {} });
    });

    it('shows the server\'s message through onError when the resolve is refused', async () => {
      api.state.refusal = { status: 400, error: 'Resolving a question requires a non-empty text (the answer)' };
      const { onError, user } = await renderActions({ kind: 'action' });

      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError).toHaveBeenCalledWith(
        'Failed to Resolve Todo',
        'Resolving a question requires a non-empty text (the answer)',
      );
    });
  });

  describe('dismiss', () => {
    it('dismisses an open item', async () => {
      const { todo, user } = await renderActions();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/api/todos/${todo.id}/dismiss` });
    });
  });

  describe('assign', () => {
    it('assigning sends the chosen user id', async () => {
      const { todo, user } = await renderActions({ assigneeUserId: null }, [ME, BOB]);

      await user.selectOptions(screen.getByLabelText(`Assignee for ${todo.title}`), BOB.id);

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({
        method: 'PATCH',
        path: `/api/todos/${todo.id}`,
        body: { assigneeUserId: BOB.id },
      });
    });

    it('unassigning sends null', async () => {
      const { todo, user } = await renderActions({ assigneeUserId: BOB.id }, [ME, BOB]);

      await user.selectOptions(screen.getByLabelText(`Assignee for ${todo.title}`), '');

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: `/api/todos/${todo.id}`, body: { assigneeUserId: null } });
    });
  });
});
