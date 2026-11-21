import { useState } from 'react';
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { createTodoApiMock, makeTodo, makeTodoComment, makeTodoMove } from '../../../test/todo-fixtures';
import type { Session, TodoActivity, Worker } from '@agent-console/shared';
import { makeSession, SessionDataProvider } from '../../../test/session-data';
import { setCurrentUser, setAuthMode, _reset as resetAuth } from '../../../lib/auth';
import { TodoDetail } from '../TodoDetail';

const ALICE = { id: 'user-alice', username: 'alice' };
const BOB = { id: 'user-bob', username: 'bob' };

const TERMINAL_BODY = 'Run it:\n\n```terminal\nbun run migrate\n```\n';

let api: ReturnType<typeof createTodoApiMock>;
let restoreFetch: () => void;

beforeEach(() => {
  api = createTodoApiMock();
  restoreFetch = api.install();
  resetAuth();
});

afterEach(() => {
  cleanup();
  restoreFetch();
  resetAuth();
});

interface RenderOptions {
  users?: { id: string; username: string }[];
  runEnabled?: boolean;
  withOnRun?: boolean;
  activities?: TodoActivity[];
  /** The root layout's session list (the detail reads titles and move targets from it). */
  sessions?: Session[];
}

async function renderDetail(overrides: Parameters<typeof makeTodo>[0] = {}, options: RenderOptions = {}) {
  const todo = makeTodo(overrides);
  api.state.todos = [todo];
  const onError = mock((_title: string, _message: string) => {});
  const onDeleted = mock(() => {});
  const onRun = mock((_command: string) => {});
  const { queryClient } = await renderWithRouter(
    <SessionDataProvider sessions={options.sessions ?? []}>
      <TodoDetail
        todo={todo}
        users={options.users ?? [ALICE]}
        activities={options.activities ?? []}
        onError={onError}
        runEnabled={options.runEnabled ?? false}
        onRun={options.withOnRun === false ? undefined : onRun}
        onDeleted={onDeleted}
        resolveBarClassName="bg-slate-800"
      />
    </SessionDataProvider>,
  );
  return { todo, onError, onDeleted, onRun, queryClient, user: userEvent.setup() };
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

    it('wraps the body in memo-content with min-w-0 so a wide code block scrolls instead of widening the card', async () => {
      // Mutation: revert the wrapper to `break-words` without memo-content -> this fails.
      await renderDetail({ body: 'Intro\n\n```sql\nSELECT 1;\n```\n' });

      const wrapper = screen.getByText('Intro').closest('.memo-content');
      expect(wrapper).not.toBeNull();
      expect(wrapper?.classList.contains('min-w-0')).toBe(true);
      expect(wrapper?.querySelector('pre')).not.toBeNull();
    });

    it('shows scope, creator and assignee as detail rows, and kind and status on one meta line', async () => {
      await renderDetail(
        { kind: 'action', scope: 'session', status: 'open', createdBy: { userId: BOB.id }, assigneeUserId: ALICE.id },
        { users: [ALICE, BOB] },
      );

      expect(screen.getByText('Created by:').nextSibling?.textContent).toBe('bob');
      expect(screen.getByText('Assigned to:').nextSibling?.textContent).toBe('alice');
      expect(screen.getByText('action · open')).toBeTruthy();
      expect(screen.getByText('Scope:').nextSibling?.textContent).toBe('session');
      expect(screen.queryByText('Status:')).toBeNull();
      expect(screen.queryByText('Kind:')).toBeNull();
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
      await user.click(screen.getByRole('button', { name: 'Edit' }));

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

    it('shows the server\'s new title and body when the item is updated elsewhere', async () => {
      const first = makeTodo({ title: 'Old title', body: 'Old body', updatedAt: '2026-10-15T00:00:00.000Z' });
      const second = { ...first, title: 'Other title', body: 'Other body', updatedAt: '2026-10-16T00:00:00.000Z' };
      function Host() {
        const [todo, setTodo] = useState(first);
        return (
          <>
            <button type="button" onClick={() => setTodo(second)}>
              simulate remote edit
            </button>
            <TodoDetail todo={todo} users={[ALICE]} activities={[]} onError={() => {}} runEnabled={false} onDeleted={() => {}} resolveBarClassName="bg-slate-800" />
          </>
        );
      }
      const user = userEvent.setup();
      await renderWithRouter(
        <SessionDataProvider>
          <Host />
        </SessionDataProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getByLabelText('Edit title') as HTMLInputElement).value).toBe('Old title');

      await user.click(screen.getByRole('button', { name: 'simulate remote edit' }));

      await waitFor(() => expect((screen.getByLabelText('Edit title') as HTMLInputElement).value).toBe('Other title'));
      expect((screen.getByLabelText('Edit body') as HTMLTextAreaElement).value).toBe('Other body');
    });

    it('Save is disabled until something changed, and for a blank title', async () => {
      const { user } = await renderDetail({ title: 'Same', body: 'Same body' });
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

      expect(save.disabled).toBe(true);
      await user.type(screen.getByLabelText('Edit body'), '!');
      expect(save.disabled).toBe(false);
      await user.clear(screen.getByLabelText('Edit title'));
      expect(save.disabled).toBe(true);
    });

    it('offers no edit for an item that is not open', async () => {
      await renderDetail({ status: 'done', resolutionText: 'ok' });

      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByLabelText('Edit title')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('is closed until Edit is clicked, and the body is then rendered once outside the form', async () => {
      // Mutation: render TodoEditForm unconditionally -> the "Edit body" assertion fails.
      const { user } = await renderDetail({ title: 'T', body: 'Only once' });

      expect(screen.getAllByText('Only once')).toHaveLength(1);
      expect(screen.queryByLabelText('Edit body')).toBeNull();
      expect(screen.queryByLabelText('Edit title')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getByLabelText('Edit title') as HTMLInputElement).value).toBe('T');
      expect((screen.getByLabelText('Edit body') as HTMLTextAreaElement).value).toBe('Only once');
    });

    it('Cancel closes the form and drops the typed input; a second open shows the server values', async () => {
      const { user } = await renderDetail({ title: 'Server title', body: 'Server body' });
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.type(screen.getByLabelText('Edit title'), ' typed');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('Edit title')).toBeNull();
      expect(api.writes()).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getByLabelText('Edit title') as HTMLInputElement).value).toBe('Server title');
    });

    it('a successful Save closes the form', async () => {
      const { user } = await renderDetail({ title: 'Old', body: '' });
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.type(screen.getByLabelText('Edit title'), ' more');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitForAbsent(() => screen.queryByLabelText('Edit title'));
    });

    it('shows the server\'s message when the edit is refused', async () => {
      api.state.refusal = { status: 409, error: 'The item is no longer open' };
      const { onError, user } = await renderDetail({ title: 'Old', body: '' });

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.type(screen.getByLabelText('Edit title'), ' more');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Update Todo', 'The item is no longer open'));
      expect((screen.getByLabelText('Edit title') as HTMLInputElement).value).toBe('Old more');
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

    it('calls onDeleted before it refetches the lists, so the host leaves before the deleted-state render', async () => {
      const { onDeleted, queryClient, user } = await renderDetail({ title: 'Doomed' });
      const order: string[] = [];
      onDeleted.mockImplementation(() => {
        order.push('onDeleted');
      });
      const invalidate = queryClient.invalidateQueries.bind(queryClient);
      queryClient.invalidateQueries = ((...args: Parameters<typeof invalidate>) => {
        order.push('invalidate');
        return invalidate(...args);
      }) as typeof queryClient.invalidateQueries;

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(order).toEqual(['onDeleted', 'invalidate']));
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

  describe('thread', () => {
    // A session the list does not hold is shown as the first eight characters of its id.
    const FROM = 'aaaaaaaa-1111-4111-8111-111111111111';
    const TO = 'bbbbbbbb-2222-4222-8222-222222222222';

    function thread(): HTMLElement {
      return screen.getByRole('region', { name: 'Thread' });
    }

    /**
     * Measured reach (each mutation applied alone to TodoDetail.tsx, the three
     * host-level files re-run; the failing tests are named here):
     *   - moved rows not rendered -> the five 'a ... move ...' row tests, 'lists the
     *     activities in the order ...', 'keeps the Thread on a dismissed item ...' (and the
     *     page test in todos.$todoId.test.tsx)
     *   - comment rendered without the author -> 'a human comment reads ...' and
     *     'an agent comment is attributed to "agent"'
     *   - Reply allowed on every status -> 'keeps the Thread on a dismissed item ...',
     *     'offers no Reply on a superseded / withdrawn item', 'shows no Thread section ...'
     *   - Thread shown only when activities exist -> both 'with no activities shows the Reply
     *     input alone' tests and the three 'reply' tests
     *   - activities sorted in the component -> 'lists the activities in the order ...'
     *   - a `never` default is a type-level pin: a third kind in the union fails tsc at the switch.
     */
    it('a human comment reads "<username> · <time>" and keeps the text\'s line breaks', async () => {
      await renderDetail(
        {},
        { users: [ALICE, BOB], activities: [makeTodoComment({ actor: { userId: BOB.id }, text: 'First line\nSecond line' })] },
      );

      const row = within(thread()).getByTestId('todo-activity-comment-1');
      expect(row.textContent).toContain('bob');
      expect(row.textContent).toContain(' · ');
      const text = within(row).getByText(/First line/);
      expect(text.textContent).toBe('First line\nSecond line');
      expect(text.className).toContain('whitespace-pre-wrap');
    });

    it('an agent comment is attributed to "agent"', async () => {
      await renderDetail({}, { activities: [makeTodoComment({ actor: { workerId: 'worker-9' }, text: 'It is the second one' })] });

      const row = within(thread()).getByTestId('todo-activity-comment-1');
      expect(row.textContent).toContain('agent');
      expect(within(row).getByText('It is the second one')).toBeTruthy();
    });

    it('a move without a statement reads "Moved from <from> to <to> by <agent>" and quotes nothing', async () => {
      await renderDetail({}, { activities: [makeTodoMove({ fromSessionId: FROM, toSessionId: TO, statement: null })] });

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(row.textContent).toContain('Moved from aaaaaaaa to bbbbbbbb by agent');
      expect(row.textContent).not.toContain('"');
      expect(row.textContent).not.toContain(' -- ');
    });

    it('a move row names a live session by its title and an unknown one by the first 8 characters of its id', async () => {
      // Mutation: sessionLabel reverted to the 8-char id -> this fails.
      await renderDetail(
        {},
        {
          sessions: [makeSession({ id: FROM, title: 'Release prep' })],
          activities: [makeTodoMove({ fromSessionId: FROM, toSessionId: TO })],
        },
      );

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(row.textContent).toContain('Moved from Release prep to bbbbbbbb by agent');
    });

    it('a human move names the human', async () => {
      await renderDetail({}, { users: [ALICE], activities: [makeTodoMove({ actor: { userId: ALICE.id }, fromSessionId: FROM, toSessionId: TO })] });

      expect(within(thread()).getByTestId('todo-activity-move-1').textContent).toContain('by alice');
    });

    it('a move with a statement and an attributed user quotes the words and names whose they are', async () => {
      await renderDetail(
        {},
        {
          users: [ALICE, BOB],
          activities: [
            makeTodoMove({ fromSessionId: FROM, toSessionId: TO, statement: 'take this one over', attributedUserId: BOB.id }),
          ],
        },
      );

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(row.textContent).toContain('"take this one over"');
      expect(row.textContent).toContain(' -- bob');
    });

    it('an unattributed statement reads exactly: on a human\'s instruction: "<words>", with no name and no " -- "', async () => {
      await renderDetail({}, { activities: [makeTodoMove({ statement: 'take this one over', attributedUserId: null })] });

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(within(row).getByText('on a human\'s instruction: "take this one over"')).toBeTruthy();
      expect(row.textContent).not.toContain(' -- ');
    });

    it('an attributed statement names the user once', async () => {
      await renderDetail(
        {},
        { users: [ALICE, BOB], activities: [makeTodoMove({ statement: 'take this one over', attributedUserId: BOB.id })] },
      );

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(within(row).getByText('"take this one over" -- bob')).toBeTruthy();
      expect(row.textContent).not.toContain('a human');
      expect(row.textContent?.match(/bob/g)).toHaveLength(1);
    });

    it('a move with no statement shows no instruction text', async () => {
      await renderDetail({}, { activities: [makeTodoMove({ statement: null, attributedUserId: null })] });

      const row = within(thread()).getByTestId('todo-activity-move-1');
      expect(row.textContent).not.toContain('instruction');
      expect(row.textContent).not.toContain('"');
      expect(row.textContent).not.toContain(' -- ');
    });

    it('a move whose item had no session reads "from no session"', async () => {
      await renderDetail({}, { activities: [makeTodoMove({ fromSessionId: null, toSessionId: TO })] });

      expect(within(thread()).getByTestId('todo-activity-move-1').textContent).toContain('Moved from no session to bbbbbbbb');
    });

    it('lists the activities in the order the server returned them, without sorting', async () => {
      // Out of id order and out of created-at order on purpose: the thread must not re-sort.
      await renderDetail(
        {},
        {
          activities: [
            makeTodoMove({ id: 'm-b', createdAt: '2026-10-15T09:00:00.000Z' }),
            makeTodoComment({ id: 'c-z', createdAt: '2026-10-15T01:00:00.000Z' }),
            makeTodoComment({ id: 'c-a', createdAt: '2026-10-15T05:00:00.000Z' }),
          ],
        },
      );

      const ids = within(thread())
        .getAllByTestId(/^todo-activity-/)
        .map((row) => row.getAttribute('data-testid'));
      expect(ids).toEqual(['todo-activity-m-b', 'todo-activity-c-z', 'todo-activity-c-a']);
    });

    it('shows no Thread section for an item that is not open or done and has no activities', async () => {
      await renderDetail({ status: 'dismissed' });

      expect(screen.queryByRole('region', { name: 'Thread' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
    });

    it('keeps the Thread on a dismissed item that has activities, read-only (move rows are not hidden)', async () => {
      await renderDetail({ status: 'dismissed' }, { activities: [makeTodoMove({ toSessionId: TO })] });

      expect(within(thread()).getByTestId('todo-activity-move-1')).toBeTruthy();
      expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    });

    it.each(['superseded', 'withdrawn'] as const)('offers no Reply on a %s item', async (status) => {
      await renderDetail({ status }, { activities: [makeTodoComment()] });

      expect(within(thread()).getByTestId('todo-activity-comment-1')).toBeTruthy();
      expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
    });

    it.each(['open', 'done'] as const)('a(n) %s item with no activities shows the Reply input alone', async (status) => {
      await renderDetail({ status, resolutionText: status === 'done' ? 'ok' : null });

      expect(within(thread()).getByRole('textbox', { name: 'Reply' })).toBeTruthy();
      expect(within(thread()).queryByTestId(/^todo-activity-/)).toBeNull();
    });
  });

  describe('reply', () => {
    it('posts the trimmed words to the comments endpoint, refetches the todo queries and clears the input', async () => {
      const { todo, queryClient, user } = await renderDetail({ kind: 'question' });
      const invalidate = mock(queryClient.invalidateQueries.bind(queryClient));
      queryClient.invalidateQueries = invalidate as typeof queryClient.invalidateQueries;

      const input = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
      await user.type(input, '  Why the second one?  ');
      await user.click(screen.getByRole('button', { name: 'Reply' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({
        method: 'POST',
        path: `/api/todos/${todo.id}/comments`,
        body: { text: 'Why the second one?' },
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todos'] }));
      await waitFor(() => expect(input.value).toBe(''));
    });

    it('Reply is disabled for empty and whitespace-only words', async () => {
      const { user } = await renderDetail({});
      const reply = screen.getByRole('button', { name: 'Reply' }) as HTMLButtonElement;

      expect(reply.disabled).toBe(true);
      await user.type(screen.getByRole('textbox', { name: 'Reply' }), '   ');
      expect(reply.disabled).toBe(true);
      await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'x');
      expect(reply.disabled).toBe(false);
      expect(api.writes()).toHaveLength(0);
    });

    it("shows the server's message and keeps the words when the reply is refused", async () => {
      api.state.refusal = { status: 409, error: 'Only an open or done item takes comments' };
      const { onError, user } = await renderDetail({});
      const input = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;

      await user.type(input, 'too late');
      await user.click(screen.getByRole('button', { name: 'Reply' }));

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith('Failed to Reply', 'Only an open or done item takes comments'),
      );
      expect(input.value).toBe('too late');
    });
  });

  describe('layout', () => {
    const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('orders body, Thread, Details, Manage and the Resolve bar top to bottom, with the Edit form closed', async () => {
      // Mutation: move the bar above the Thread in TodoDetail -> the Thread < Resolve assertion fails.
      await renderDetail(
        { kind: 'action', status: 'open', body: 'The body text' },
        { users: [ALICE, BOB], activities: [makeTodoComment({ text: 'First comment' })] },
      );

      const body = screen.getByText('The body text');
      const thread = screen.getByRole('region', { name: 'Thread' });
      const details = screen.getByRole('heading', { name: 'Details' });
      const manage = screen.getByRole('heading', { name: 'Manage' });
      const resolve = screen.getByRole('button', { name: 'Resolve' });

      expect(precedes(body, thread)).toBe(true);
      expect(precedes(thread, details)).toBe(true);
      expect(precedes(details, manage)).toBe(true);
      expect(precedes(manage, resolve)).toBe(true);
      expect(screen.queryByLabelText('Edit title')).toBeNull();
    });

    it('puts the title first and the meta line directly under it, before the body', async () => {
      await renderDetail({ title: 'Heading', kind: 'question', status: 'open', body: 'The body text' });

      const title = screen.getByRole('heading', { name: 'Heading' });
      const meta = screen.getByText('question · open');
      expect(precedes(title, meta)).toBe(true);
      expect(precedes(meta, screen.getByText('The body text'))).toBe(true);
      expect(screen.queryByRole('heading', { name: 'Body' })).toBeNull();
    });

    it('an item with no body and no activities shows the meta line, then the Thread holding only the Reply form', async () => {
      await renderDetail({ body: '', status: 'open' });

      const thread = screen.getByRole('region', { name: 'Thread' });
      expect(precedes(screen.getByText('action · open'), thread)).toBe(true);
      expect(within(thread).queryByRole('list')).toBeNull();
      expect(within(thread).getByRole('textbox', { name: 'Reply' })).toBeTruthy();
    });

    describe('Resolve bar', () => {
      it.each(['open', 'done'] as const)('is rendered for a %s item, sticky at the bottom with the host background', async (status) => {
        await renderDetail({ status, resolutionText: status === 'done' ? 'ok' : null });

        const bar = screen.getByTestId('todo-resolve-bar');
        expect(bar.classList.contains('sticky')).toBe(true);
        expect(bar.classList.contains('bottom-0')).toBe(true);
        expect(bar.classList.contains('bg-slate-800')).toBe(true);
        expect(within(bar).getByRole('button', { name: 'Resolve' })).toBeTruthy();
      });

      it.each(['superseded', 'dismissed', 'withdrawn'] as const)('is not rendered for a %s item', async (status) => {
        await renderDetail({ status });

        expect(screen.queryByTestId('todo-resolve-bar')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
      });

      it('is the last element of the detail root', async () => {
        const { todo } = await renderDetail({ status: 'open' });

        const root = screen.getByTestId(`todo-detail-${todo.id}`);
        expect(root.lastElementChild).toBe(screen.getByTestId('todo-resolve-bar'));
      });

      it('open action, multi-user: Resolve and Dismiss in the bar, the Assignee select not', async () => {
        const { todo } = await renderDetail({ kind: 'action' }, { users: [ALICE, BOB] });

        const bar = screen.getByTestId('todo-resolve-bar');
        expect(within(bar).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
        expect(within(bar).queryByLabelText(`Assignee for ${todo.title}`)).toBeNull();
      });

      it('open question, single-user: the input asks for a required answer', async () => {
        await renderDetail({ kind: 'question' });

        const bar = screen.getByTestId('todo-resolve-bar');
        expect(within(bar).getByPlaceholderText('Answer (required)')).toBeTruthy();
        expect(within(bar).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
      });

      it('done: the input adds to the resolution and there is no Dismiss', async () => {
        await renderDetail({ status: 'done', resolutionText: 'ok' });

        const bar = screen.getByTestId('todo-resolve-bar');
        expect(within(bar).getByPlaceholderText('Add to the resolution')).toBeTruthy();
        expect(within(bar).queryByRole('button', { name: 'Dismiss' })).toBeNull();
      });
    });

    describe('Manage contents', () => {
      const manageOf = () => screen.getByRole('heading', { name: 'Manage' }).closest('section') as HTMLElement;

      it('open action, multi-user: Edit, Assignee, Scope, Move and Delete, in that order', async () => {
        const { todo } = await renderDetail({ kind: 'action', status: 'open' }, { users: [ALICE, BOB] });

        const manage = manageOf();
        const edit = within(manage).getByRole('button', { name: 'Edit' });
        const assignee = within(manage).getByLabelText(`Assignee for ${todo.title}`);
        const scope = within(manage).getByRole('heading', { name: 'Scope' });
        const move = within(manage).getByRole('heading', { name: 'Move to session' });
        const del = within(manage).getByRole('button', { name: 'Delete' });
        expect(precedes(edit, assignee)).toBe(true);
        expect(precedes(assignee, scope)).toBe(true);
        expect(precedes(scope, move)).toBe(true);
        expect(precedes(move, del)).toBe(true);
      });

      it('open question, single-user: Edit, Move and Delete, with no Assignee and no Scope', async () => {
        const { todo } = await renderDetail({ kind: 'question', status: 'open' });

        const manage = manageOf();
        expect(within(manage).getByRole('button', { name: 'Edit' })).toBeTruthy();
        expect(within(manage).getByRole('heading', { name: 'Move to session' })).toBeTruthy();
        expect(within(manage).getByRole('button', { name: 'Delete' })).toBeTruthy();
        expect(within(manage).queryByLabelText(`Assignee for ${todo.title}`)).toBeNull();
        expect(within(manage).queryByRole('heading', { name: 'Scope' })).toBeNull();
      });

      it.each(['done', 'superseded', 'dismissed', 'withdrawn'] as const)('a %s item: Delete only', async (status) => {
        await renderDetail({ status, resolutionText: 'ok' }, { users: [ALICE, BOB] });

        const manage = manageOf();
        expect(within(manage).getByRole('button', { name: 'Delete' })).toBeTruthy();
        expect(within(manage).queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(within(manage).queryByRole('combobox')).toBeNull();
      });
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

  describe('move to session', () => {
    const MINE = 'user-me';
    const THEIRS = 'user-bob';
    const TERMINAL = { id: 'w-term', type: 'terminal', name: 'Shell', createdAt: '2026-10-15T00:00:00.000Z', activated: true } as Worker;
    const GIT_DIFF = { id: 'w-diff', type: 'git-diff', name: 'Diff', createdAt: '2026-10-15T00:00:00.000Z', baseCommit: 'abc123' } as Worker;
    const sessions = [
      makeSession({ id: 'current-session', title: 'Current', createdBy: MINE, workers: [TERMINAL] }),
      makeSession({ id: 'mine-session', title: 'My work', createdBy: MINE, createdByUsername: 'me', workers: [TERMINAL] }),
      makeSession({ id: 'shared-session', title: 'Team room', createdBy: 'shared-acct', createdByUsername: 'team', isShared: true, workers: [TERMINAL] }),
      makeSession({ id: 'bobs-session', title: 'Bob work', createdBy: THEIRS, createdByUsername: 'bob', workers: [TERMINAL] }),
      makeSession({ id: 'cccccccc-paused', title: 'Paused one', createdBy: MINE, pausedAt: '2026-10-16T00:00:00.000Z', workers: [TERMINAL] }),
    ];

    function signInMultiUser() {
      setAuthMode('multi-user');
      setCurrentUser({ id: MINE, username: 'me', homeDir: '/home/me' });
    }

    function picker(): HTMLSelectElement {
      return screen.getByLabelText('Move to session') as HTMLSelectElement;
    }

    function optionTexts(): string[] {
      return within(picker()).getAllByRole('option').map((o) => o.textContent ?? '').filter((t) => t !== 'Choose a session');
    }

    /**
     * Measured reach (each mutation applied alone to TodoDetail.tsx, this file re-run):
     *   - drop the isShared disjunct -> 'lists only my own and shared live sessions ...'
     *   - Move enabled without a choice -> 'Move is disabled until a target is chosen'
     *   - current session not excluded -> 'lists only my own and shared live sessions ...'
     *   - picker shown for a non-open item -> 'offers no picker on an item that is not open'
     */
    it('lists only my own and shared live sessions, never the item\'s current one or a paused one', async () => {
      signInMultiUser();
      await renderDetail({ sessionId: 'current-session' }, { sessions });

      expect(optionTexts()).toEqual(['My work', 'Team room']);
    });

    it('"All sessions" adds the rest of the live sessions with their owners\' usernames', async () => {
      signInMultiUser();
      const { user } = await renderDetail({ sessionId: 'current-session' }, { sessions });

      await user.click(screen.getByLabelText('All sessions'));

      expect(optionTexts()).toEqual(['My work (me)', 'Team room (team)', 'Bob work (bob)']);
    });

    it('offers no "All sessions" checkbox in single-user mode and lists every other live session', async () => {
      await renderDetail({ sessionId: 'current-session' }, { sessions });

      expect(screen.queryByLabelText('All sessions')).toBeNull();
      expect(optionTexts()).toEqual(['My work', 'Team room', 'Bob work']);
    });

    it('labels a session without a title by the first 8 characters of its id', async () => {
      signInMultiUser();
      await renderDetail(
        { sessionId: 'current-session' },
        { sessions: [makeSession({ id: 'dddddddd-4444-4444-8444-444444444444', createdBy: MINE, workers: [TERMINAL] })] },
      );

      expect(optionTexts()).toEqual(['dddddddd']);
    });

    it('Move is disabled until a target is chosen', async () => {
      signInMultiUser();
      const { user } = await renderDetail({ sessionId: 'current-session' }, { sessions });

      const move = screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement;
      expect(move.disabled).toBe(true);
      await user.selectOptions(picker(), 'mine-session');
      expect(move.disabled).toBe(false);
    });

    it('Move posts the chosen session id, without a worker, and refetches the todo queries', async () => {
      signInMultiUser();
      const { todo, queryClient, user } = await renderDetail({ sessionId: 'current-session' }, { sessions });
      const invalidate = mock(queryClient.invalidateQueries.bind(queryClient));
      queryClient.invalidateQueries = invalidate as typeof queryClient.invalidateQueries;

      await user.selectOptions(picker(), 'shared-session');
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(api.writes()).toHaveLength(1));
      expect(api.writes()[0]).toMatchObject({
        method: 'POST',
        path: `/api/todos/${todo.id}/move`,
        body: { sessionId: 'shared-session' },
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todos'] }));
    });

    it('surfaces the server\'s refusal text through onError', async () => {
      signInMultiUser();
      api.state.refusal = { status: 409, error: 'Target session has no worker that can receive notifications' };
      const { onError, user } = await renderDetail({ sessionId: 'current-session' }, { sessions });

      await user.selectOptions(picker(), 'mine-session');
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith('Failed to Move', 'Target session has no worker that can receive notifications'),
      );
    });

    describe('delivery worker (agent-created items only)', () => {
      const bare = makeSession({ id: 'bare-session', title: 'No workers', createdBy: MINE });
      const diffOnly = makeSession({ id: 'diff-session', title: 'Diff only', createdBy: MINE, workers: [GIT_DIFF] });
      const withTerminal = makeSession({ id: 'term-session', title: 'Has shell', createdBy: MINE, workers: [TERMINAL] });
      const withAgent = makeSession({
        id: 'agent-session',
        title: 'Has agent',
        createdBy: MINE,
        workers: [{ id: 'w-agent', type: 'agent', name: 'Claude', createdAt: '2026-10-15T00:00:00.000Z', agentId: 'claude-code-builtin', activated: true } as Worker],
      });

      // Mutation: drop the needsDeliveryWorker filter -> the first two tests fail.
      it('omits a workerless session and a git-diff-only session for an agent-created item', async () => {
        signInMultiUser();
        await renderDetail({ createdBy: { workerId: 'w1' }, sessionId: 'current-session' }, { sessions: [bare, diffOnly, withTerminal, withAgent] });

        expect(optionTexts()).toEqual(['Has shell', 'Has agent']);
      });

      it('offers a session with a terminal or agent worker for an agent-created item', async () => {
        signInMultiUser();
        await renderDetail({ createdBy: { workerId: 'w1' }, sessionId: 'current-session' }, { sessions: [withTerminal, withAgent] });

        expect(optionTexts()).toEqual(['Has shell', 'Has agent']);
      });

      it('keeps every live session, workerless included, for a human-created item', async () => {
        signInMultiUser();
        await renderDetail({ createdBy: { userId: MINE }, sessionId: 'current-session' }, { sessions: [bare, diffOnly, withTerminal] });

        expect(optionTexts()).toEqual(['No workers', 'Diff only', 'Has shell']);
      });
    });

    it('is offered on an open question as well as an open action', async () => {
      signInMultiUser();
      await renderDetail({ kind: 'question', sessionId: 'current-session' }, { sessions });

      expect(picker()).toBeTruthy();
    });

    it('offers no picker on an item that is not open', async () => {
      signInMultiUser();
      await renderDetail({ status: 'done', resolutionText: 'ok', sessionId: 'current-session' }, { sessions });

      expect(screen.queryByLabelText('Move to session')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    });
  });
});
