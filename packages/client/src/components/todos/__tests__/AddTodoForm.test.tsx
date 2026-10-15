import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { createTodoApiMock } from '../../../test/todo-fixtures';
import { AddTodoForm } from '../AddTodoForm';

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

async function renderForm(users = [ME]) {
  const onError = mock((_title: string, _message: string) => {});
  await renderWithRouter(<AddTodoForm users={users} knownSessionIds={['session-1']} onError={onError} />);
  return { onError, user: userEvent.setup() };
}

describe('AddTodoForm', () => {
  it('does not submit without a title', async () => {
    const { user } = await renderForm();

    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.click(add);

    expect(api.writes()).toHaveLength(0);
  });

  it('sends no scope when none is chosen, so the server derives it (global without a session)', async () => {
    const { user } = await renderForm();

    await user.type(screen.getByLabelText('Title'), '  Buy milk  ');
    await user.type(screen.getByLabelText('Body'), 'Two litres');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/api/todos' });
    expect(api.writes()[0]?.body).toEqual({ kind: 'action', title: 'Buy milk', body: 'Two litres' });
  });

  it('sends the session id when one is given, still without an explicit scope', async () => {
    const { user } = await renderForm();

    await user.type(screen.getByLabelText('Title'), 'Review the diff');
    await user.type(screen.getByLabelText('Session id'), 'session-1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toEqual({ kind: 'action', title: 'Review the diff', body: '', sessionId: 'session-1' });
  });

  it('sends the chosen kind and explicit scope', async () => {
    const { user } = await renderForm();

    await user.selectOptions(screen.getByLabelText('Kind'), 'question');
    await user.selectOptions(screen.getByLabelText('Scope'), 'session');
    await user.type(screen.getByLabelText('Title'), 'Which branch?');
    await user.type(screen.getByLabelText('Session id'), 'session-1');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toMatchObject({ kind: 'question', scope: 'session', sessionId: 'session-1' });
  });

  it('hides the assignee control when the directory has one user', async () => {
    await renderForm([ME]);

    expect(screen.queryByLabelText('Assignee')).toBeNull();
  });

  it('sends the chosen assignee when the directory has several users', async () => {
    const { user } = await renderForm([ME, BOB]);

    await user.type(screen.getByLabelText('Title'), 'Approve the deploy');
    await user.selectOptions(screen.getByLabelText('Assignee'), BOB.id);
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toMatchObject({ assigneeUserId: BOB.id });
  });

  it('clears the form after a successful add', async () => {
    const { user } = await renderForm();

    await user.type(screen.getByLabelText('Title'), 'One-off');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(''));
  });

  it('shows the server\'s message and keeps the typed text when the add is refused', async () => {
    api.state.refusal = { status: 404, error: 'Session not found' };
    const { onError, user } = await renderForm();

    await user.type(screen.getByLabelText('Title'), 'Orphan');
    await user.type(screen.getByLabelText('Session id'), 'session-gone');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to Add To-do', 'Session not found'));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Orphan');
  });
});
