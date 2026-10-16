import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { createTodoApiMock, makeTodo } from '../../../test/todo-fixtures';
import { TodoDetail } from '../TodoDetail';

const ALICE = { id: 'user-alice', username: 'alice' };
const BOB = { id: 'user-bob', username: 'bob' };

const TERMINAL_BODY = 'Run it:\n\n```terminal\nbun run migrate\n```\n';

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

interface RenderOptions {
  users?: { id: string; username: string }[];
  runEnabled?: boolean;
  withOnRun?: boolean;
}

async function renderDetail(overrides: Parameters<typeof makeTodo>[0] = {}, options: RenderOptions = {}) {
  const todo = makeTodo(overrides);
  api.state.todos = [todo];
  const onError = mock((_title: string, _message: string) => {});
  const onDeleted = mock(() => {});
  const onRun = mock((_command: string) => {});
  await renderWithRouter(
    <TodoDetail
      todo={todo}
      users={options.users ?? [ALICE]}
      onError={onError}
      runEnabled={options.runEnabled ?? false}
      onRun={options.withOnRun === false ? undefined : onRun}
      onDeleted={onDeleted}
    />,
  );
  return { todo, onError, onDeleted, onRun, user: userEvent.setup() };
}

/**
 * Mutations noted per test (each applied alone to TodoDetail.tsx; the first
 * two also name the test that fails):
 *   - pass `onRun` to the body regardless of `runEnabled`
 *     -> 'runEnabled false: Copy and Open in session, never Run'
 *   - swap the provenance branch (worker id null reads as an agent recording)
 *     -> the human / agent-recorded / unknown-user provenance tests
 *   - drop the `title`/`body` fields from the PATCH -> 'saves title and body'
 *   - call `onDeleted` before the confirm -> 'asks for confirmation ...'
 */
describe('TodoDetail', () => {
  describe('display', () => {
    it('renders the full body as markdown', async () => {
      await renderDetail({ body: 'Check **this** now\n\nSecond paragraph' });

      expect(screen.getByText('this').tagName).toBe('STRONG');
      expect(screen.getByText('Second paragraph')).toBeTruthy();
    });

    it('shows kind, scope, status, creator and assignee as detail rows', async () => {
      await renderDetail(
        { kind: 'action', scope: 'session', status: 'open', createdBy: { userId: BOB.id }, assigneeUserId: ALICE.id },
        { users: [ALICE, BOB] },
      );

      expect(screen.getByText('Created by:').nextSibling?.textContent).toBe('bob');
      expect(screen.getByText('Assigned to:').nextSibling?.textContent).toBe('alice');
      expect(screen.getByText('Status:').nextSibling?.textContent).toBe('open');
    });

    it('shows the resolved-at row only for a resolved item', async () => {
      await renderDetail({ status: 'done', resolutionText: 'ok', resolvedAt: '2026-10-16T00:00:00.000Z' });
      expect(screen.getByText('Resolved at:')).toBeTruthy();
      cleanup();

      await renderDetail({});
      expect(screen.queryByText('Resolved at:')).toBeNull();
    });
  });

  describe('resolution provenance', () => {
    it('a human resolution reads "resolved by <username>"', async () => {
      await renderDetail({
        status: 'done',
        resolutionText: 'Applied',
        resolvedByUserId: ALICE.id,
        resolvedByWorkerId: null,
      });

      expect(screen.getByText('Applied')).toBeTruthy();
      expect(screen.getByText('resolved by alice')).toBeTruthy();
    });

    it('an agent recording a human\'s statement reads "recorded by an agent from <username>\'s statement"', async () => {
      await renderDetail({
        status: 'done',
        resolutionText: 'Applied',
        resolvedByUserId: ALICE.id,
        resolvedByWorkerId: 'worker-9',
      });

      expect(screen.getByText("recorded by an agent from alice's statement")).toBeTruthy();
      expect(screen.queryByText('resolved by alice')).toBeNull();
    });

    it('an agent recording with no known user reads "recorded by an agent"', async () => {
      await renderDetail({
        status: 'done',
        resolutionText: 'Applied',
        resolvedByUserId: null,
        resolvedByWorkerId: 'worker-9',
      });

      expect(screen.getByText('recorded by an agent')).toBeTruthy();
    });

    it('shows no provenance line for an item nobody resolved', async () => {
      await renderDetail({});

      expect(screen.queryByText(/resolved by|recorded by/)).toBeNull();
    });
  });

  describe('terminal blocks', () => {
    it('runEnabled false: Copy and Open in session, never Run', async () => {
      // Mutation: pass onRun to the body regardless of runEnabled -> the Run assertion fails.
      await renderDetail({ body: TERMINAL_BODY, sessionId: 'session-42' }, { runEnabled: false });

      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run command in terminal' })).toBeNull();
      expect(screen.getByText('Open in session').closest('a')?.getAttribute('href')).toBe('/sessions/session-42');
    });

    it('runEnabled true: Run is offered and runs the block text; no Open in session link', async () => {
      const { onRun, user } = await renderDetail({ body: TERMINAL_BODY, sessionId: 'session-42' }, { runEnabled: true });

      await user.click(screen.getByRole('button', { name: 'Run command in terminal' }));

      expect(onRun).toHaveBeenCalledWith('bun run migrate');
      expect(screen.queryByText('Open in session')).toBeNull();
    });

    it('runEnabled false with no session: no Open in session link', async () => {
      await renderDetail({ body: TERMINAL_BODY, scope: 'global', sessionId: null }, { runEnabled: false });

      expect(screen.queryByText('Open in session')).toBeNull();
    });
  });

  describe('edit', () => {
    it('saves title and body in one PATCH', async () => {
      const { todo, user } = await renderDetail({ title: 'Old title', body: 'Old body' });

      const title = screen.getByLabelText('Edit title');
      await user.clear(title);
      await user.type(title, 'New title');
      const body = screen.getByLabelText('Edit body');
      await user.clear(body);
      await user.type(body, 'New body');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({
        method: 'PATCH',
        path: `/api/todos/${todo.id}`,
        body: { title: 'New title', body: 'New body' },
      });
    });

    it('Save is disabled until something changed, and for a blank title', async () => {
      const { user } = await renderDetail({ title: 'Same', body: 'Same body' });
      const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

      expect(save.disabled).toBe(true);
      await user.type(screen.getByLabelText('Edit body'), '!');
      expect(save.disabled).toBe(false);
      await user.clear(screen.getByLabelText('Edit title'));
      expect(save.disabled).toBe(true);
    });

    it('offers no edit for an item that is not open', async () => {
      await renderDetail({ status: 'done', resolutionText: 'ok' });

      expect(screen.queryByLabelText('Edit title')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('shows the server\'s message when the edit is refused', async () => {
      api.state.refusal = { status: 409, error: 'The item is no longer open' };
      const { onError, user } = await renderDetail({ title: 'Old', body: '' });

      await user.type(screen.getByLabelText('Edit title'), ' more');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Update Todo', 'The item is no longer open'));
    });
  });

  describe('delete', () => {
    it('asks for confirmation, deletes only after the confirm, then calls onDeleted', async () => {
      const { todo, onDeleted, user } = await renderDetail({ title: 'Doomed' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.getByText(/Are you sure you want to delete "Doomed"/)).toBeTruthy());
      expect(api.writes()).toHaveLength(0);
      expect(onDeleted).not.toHaveBeenCalled();

      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
      expect(api.writes()).toHaveLength(1);
      expect(api.writes()[0]).toMatchObject({ method: 'DELETE', path: `/api/todos/${todo.id}` });
    });

    it('cancelling the confirmation deletes nothing and does not call onDeleted', async () => {
      const { onDeleted, user } = await renderDetail({ title: 'Spared' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitForAbsent(() => screen.queryByRole('alertdialog'));
      expect(api.writes()).toHaveLength(0);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('shows the server\'s message when the delete is refused (404) and does not call onDeleted', async () => {
      api.state.refusal = { status: 404, error: 'Todo not found' };
      const { onError, onDeleted, user } = await renderDetail({ title: 'Gone' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Delete Todo', 'Todo not found'));
      expect(onDeleted).not.toHaveBeenCalled();
    });
  });

  describe('resolve, dismiss and assign', () => {
    it('carries the shared action controls (resolve, dismiss, assignee)', async () => {
      const { todo } = await renderDetail({}, { users: [ALICE, BOB] });

      expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
      expect(screen.getByLabelText(`Assignee for ${todo.title}`)).toBeTruthy();
    });
  });

  describe('re-scope', () => {
    it('makes an open session-scoped action global', async () => {
      const { todo, user } = await renderDetail({ kind: 'action', scope: 'session' });

      await user.click(screen.getByRole('button', { name: 'Make global' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: `/api/todos/${todo.id}`, body: { scope: 'global' } });
    });

    it('attaches a global action to its stored session without asking for one', async () => {
      const { user } = await renderDetail({ kind: 'action', scope: 'global', sessionId: 'session-stored' });

      await user.click(screen.getByRole('button', { name: 'Attach to a session' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]?.body).toEqual({ scope: 'session' });
    });

    it('asks for a session id when a global action has none stored, then sends it', async () => {
      const { todo, user } = await renderDetail({ kind: 'action', scope: 'global', sessionId: null });

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
      const { onError, user } = await renderDetail({ kind: 'action', scope: 'session' });

      await user.click(screen.getByRole('button', { name: 'Make global' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Re-scope Todo', 'Session not found'));
    });

    it('offers no re-scope for a question (always session-scoped)', async () => {
      await renderDetail({ kind: 'question', scope: 'session' });

      expect(screen.queryByRole('button', { name: 'Make global' })).toBeNull();
    });

    it('offers no re-scope for an item that is not open', async () => {
      await renderDetail({ kind: 'action', scope: 'session', status: 'done', resolutionText: 'ok' });

      expect(screen.queryByRole('button', { name: 'Make global' })).toBeNull();
    });
  });
});
