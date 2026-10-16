import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { TodoRow } from '../TodoRow';

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

async function renderRow(overrides: Parameters<typeof makeTodo>[0] = {}, users = [ME]) {
  const todo = makeTodo(overrides);
  api.state.todos = [todo];
  const onError = mock((_title: string, _message: string) => {});
  await renderWithRouter(
    <ul>
      <TodoRow todo={todo} users={users} onError={onError} />
    </ul>,
  );
  return { todo, onError, user: userEvent.setup() };
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone to
 * TodoRow.tsx, every to-do test file re-run, production file restored after):
 *
 *   the assignee control shown at one user (`users.length > 1` gate removed)
 *     -> here, alone: 'hides the assignee control when the directory has one user'
 *        (also TodosPage.test.tsx 'hides the per-row assignee control when the directory has one user')
 *   a question resolve allowed with empty text (`resolveNeedsText` forced false)
 *     -> here: 'a question needs non-empty text before Resolve is enabled' and
 *        'a whitespace-only answer does not enable Resolve for a question'
 *        (also TodosPage.test.tsx 'a question cannot be resolved without text (nothing is sent)')
 */
describe('TodoRow', () => {
  describe('display', () => {
    it('shows the title, kind, scope and status badges', async () => {
      await renderRow({ title: 'Ship it', kind: 'question', scope: 'session', status: 'open' });

      expect(screen.getByText('Ship it')).toBeTruthy();
      expect(screen.getByLabelText('Kind: question')).toBeTruthy();
      expect(screen.getByLabelText('Scope: session')).toBeTruthy();
      expect(screen.getByLabelText('Status: open')).toBeTruthy();
    });

    it('renders the body as markdown', async () => {
      await renderRow({ body: 'Check **this** now' });

      expect(screen.getByText('this').tagName).toBe('STRONG');
    });

    it('labels a human creator by username and an agent creator as an agent', async () => {
      await renderRow({ createdBy: { userId: BOB.id } }, [ME, BOB]);
      expect(screen.getByText('Created by bob')).toBeTruthy();
      cleanup();

      await renderRow({ createdBy: { workerId: 'worker-1' } });
      expect(screen.getByText('Created by an agent')).toBeTruthy();
    });

    it('shows the assignee when one is set', async () => {
      await renderRow({ assigneeUserId: BOB.id }, [ME, BOB]);

      expect(screen.getByText('Assigned to bob')).toBeTruthy();
    });

    it('links to the item\'s session when it has one', async () => {
      await renderRow({ sessionId: 'session-42' });

      expect(screen.getByText('Open session').closest('a')?.getAttribute('href')).toBe('/sessions/session-42');
    });

    it('has no session link for an item without a session', async () => {
      await renderRow({ scope: 'global', sessionId: null });

      expect(screen.queryByText('Open session')).toBeNull();
    });

    it('shows the existing resolution text', async () => {
      await renderRow({ status: 'done', resolutionText: 'Applied in prod' });

      expect(screen.getByText('Applied in prod')).toBeTruthy();
    });
  });

  describe('resolve', () => {
    it('resolves an action with no text (the text is optional)', async () => {
      const { todo, user } = await renderRow({ kind: 'action' });

      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/api/todos/${todo.id}/resolve`, body: {} });
    });

    it('sends the text typed into the resolution box', async () => {
      const { todo, user } = await renderRow({ kind: 'action' });

      await user.type(screen.getByLabelText(`Resolution text for ${todo.title}`), 'Done by hand');
      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ text: 'Done by hand' });
    });

    it('a question needs non-empty text before Resolve is enabled', async () => {
      const { todo, user } = await renderRow({ kind: 'question' });
      const resolve = screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement;

      expect(resolve.disabled).toBe(true);
      await user.click(resolve);
      expect(api.writes()).toHaveLength(0);

      await user.type(screen.getByLabelText(`Resolution text for ${todo.title}`), 'Yes');
      expect(resolve.disabled).toBe(false);
      await user.click(resolve);

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ text: 'Yes' });
    });

    it('a whitespace-only answer does not enable Resolve for a question', async () => {
      const { todo, user } = await renderRow({ kind: 'question' });

      await user.type(screen.getByLabelText(`Resolution text for ${todo.title}`), '   ');

      expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('a done item still offers Resolve, to append to its resolution', async () => {
      const { todo, user } = await renderRow({ status: 'done', resolutionText: 'First' });

      await user.type(screen.getByLabelText(`Resolution text for ${todo.title}`), 'Second');
      await user.click(screen.getByRole('button', { name: 'Resolve' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ path: `/api/todos/${todo.id}/resolve`, body: { text: 'Second' } });
    });

    it.each(['dismissed', 'withdrawn', 'superseded'] as const)('a %s item offers no resolve control', async (status) => {
      await renderRow({ status });

      expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    });

    it('shows the server\'s message when the resolve is refused', async () => {
      api.state.refusal = { status: 400, error: 'Resolving a question requires a non-empty text (the answer)' };
      const { todo, onError, user } = await renderRow({ kind: 'action' });
      void todo;

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
      const { todo, user } = await renderRow();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/api/todos/${todo.id}/dismiss` });
    });

    it('offers no dismiss for a done item', async () => {
      await renderRow({ status: 'done', resolutionText: 'ok' });

      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    });

    it('shows the server\'s message when the dismiss is refused (409)', async () => {
      api.state.refusal = { status: 409, error: 'The item is no longer open' };
      const { onError, user } = await renderRow();

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Dismiss Todo', 'The item is no longer open'));
    });
  });

  describe('delete', () => {
    it('asks for confirmation and only deletes after the confirm', async () => {
      const { todo, user } = await renderRow({ title: 'Doomed' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.getByText(/Are you sure you want to delete "Doomed"/)).toBeTruthy());
      expect(api.writes()).toHaveLength(0);

      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'DELETE', path: `/api/todos/${todo.id}` });
    });

    it('cancelling the confirmation deletes nothing', async () => {
      const { user } = await renderRow({ title: 'Spared' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitForAbsent(() => screen.queryByRole('alertdialog'));
      expect(api.writes()).toHaveLength(0);
    });

    it('shows the server\'s message when the delete is refused (404)', async () => {
      api.state.refusal = { status: 404, error: 'Todo not found' };
      const { onError, user } = await renderRow({ title: 'Gone' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Delete Todo', 'Todo not found'));
    });
  });

  describe('assign', () => {
    it('hides the assignee control when the directory has one user', async () => {
      const { todo } = await renderRow({}, [ME]);

      expect(screen.queryByLabelText(`Assignee for ${todo.title}`)).toBeNull();
    });

    it('shows the assignee control when the directory has several users', async () => {
      const { todo } = await renderRow({}, [ME, BOB]);

      expect(screen.getByLabelText(`Assignee for ${todo.title}`)).toBeTruthy();
    });

    it('offers no assignee control for a non-open item even with several users', async () => {
      const { todo } = await renderRow({ status: 'done', resolutionText: 'ok' }, [ME, BOB]);

      expect(screen.queryByLabelText(`Assignee for ${todo.title}`)).toBeNull();
    });

    it('assigning sends the chosen user id, unassigning sends null', async () => {
      const { todo, user } = await renderRow({ assigneeUserId: null }, [ME, BOB]);

      await user.selectOptions(screen.getByLabelText(`Assignee for ${todo.title}`), BOB.id);
      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: `/api/todos/${todo.id}`, body: { assigneeUserId: BOB.id } });
      cleanup();

      api.state.calls = [];
      const second = await renderRow({ assigneeUserId: BOB.id }, [ME, BOB]);
      await second.user.selectOptions(screen.getByLabelText(`Assignee for ${second.todo.title}`), '');
      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ assigneeUserId: null });
    });

    it('shows the server\'s message when the assignment is refused (404 unknown user)', async () => {
      api.state.refusal = { status: 404, error: 'User not found' };
      const { todo, onError, user } = await renderRow({}, [ME, BOB]);

      await user.selectOptions(screen.getByLabelText(`Assignee for ${todo.title}`), BOB.id);

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Assign Todo', 'User not found'));
    });
  });

  describe('re-scope', () => {
    it('makes an open session-scoped action global', async () => {
      const { todo, user } = await renderRow({ kind: 'action', scope: 'session' });

      await user.click(screen.getByRole('button', { name: 'Make global' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: `/api/todos/${todo.id}`, body: { scope: 'global' } });
    });

    it('attaches a global action to its stored session without asking for one', async () => {
      const { user } = await renderRow({ kind: 'action', scope: 'global', sessionId: 'session-stored' });

      await user.click(screen.getByRole('button', { name: 'Attach to a session' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ scope: 'session' });
    });

    it('asks for a session id when a global action has none stored, then sends it', async () => {
      const { todo, user } = await renderRow({ kind: 'action', scope: 'global', sessionId: null });

      await user.click(screen.getByRole('button', { name: 'Attach to a session' }));
      expect(api.writes()).toHaveLength(0);
      const attach = screen.getByRole('button', { name: 'Attach' }) as HTMLButtonElement;
      expect(attach.disabled).toBe(true);

      await user.type(screen.getByLabelText(`Session id for ${todo.title}`), ' session-new ');
      await user.click(attach);

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ scope: 'session', sessionId: 'session-new' });
    });

    it('shows the server\'s refusal message', async () => {
      api.state.refusal = { status: 404, error: 'Session not found' };
      const { onError, user } = await renderRow({ kind: 'action', scope: 'session' });

      await user.click(screen.getByRole('button', { name: 'Make global' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Re-scope Todo', 'Session not found'));
    });

    it('offers no re-scope for a question (always session-scoped)', async () => {
      await renderRow({ kind: 'question', scope: 'session' });

      expect(screen.queryByRole('button', { name: 'Make global' })).toBeNull();
    });

    it('offers no re-scope for an item that is not open', async () => {
      await renderRow({ kind: 'action', scope: 'session', status: 'done', resolutionText: 'ok' });

      expect(screen.queryByRole('button', { name: 'Make global' })).toBeNull();
    });
  });
});
