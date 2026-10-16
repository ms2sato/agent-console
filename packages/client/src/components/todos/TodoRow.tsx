import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Todo, UsersListResponse } from '@agent-console/shared';
import { updateTodo, resolveTodo, dismissTodo, deleteTodo } from '../../lib/api';
import { todoKeys } from '../../lib/query-keys';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { TodoBodyMarkdown } from './TodoBodyMarkdown';

type DirectoryUsers = UsersListResponse['users'];

const BADGE_CLASS = 'shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium leading-none';
const UNASSIGNED_VALUE = '';

interface TodoRowProps {
  todo: Todo;
  users: DirectoryUsers;
  /** Shows a refused or failed action; the message is the server's own. */
  onError: (title: string, message: string) => void;
}

function usernameOf(users: DirectoryUsers, userId: string): string {
  return users.find((user) => user.id === userId)?.username ?? 'unknown user';
}

function creatorLabel(todo: Todo, users: DirectoryUsers): string {
  return 'userId' in todo.createdBy ? usernameOf(users, todo.createdBy.userId) : 'an agent';
}

export function TodoRow({ todo, users, onError }: TodoRowProps) {
  const queryClient = useQueryClient();
  const [resolutionText, setResolutionText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [askSessionId, setAskSessionId] = useState(false);
  const [sessionIdInput, setSessionIdInput] = useState('');

  const isOpen = todo.status === 'open';
  const canResolve = todo.status === 'open' || todo.status === 'done';
  const isQuestion = todo.kind === 'question';
  const resolveNeedsText = isQuestion && resolutionText.trim() === '';
  // The directory has one member in single-user mode: assignment has no meaning there.
  const canAssign = isOpen && users.length > 1;
  // A question is always session-scoped; only an open action can be re-scoped.
  const canReScope = isOpen && todo.kind === 'action';

  // The server composes the item; every mutation refetches the lists instead of
  // writing the response into the cache.
  const settled = () => queryClient.invalidateQueries({ queryKey: todoKeys.root() });
  const failed = (title: string) => (err: Error) => onError(title, err.message);

  const resolveMutation = useMutation({
    mutationFn: () => resolveTodo(todo.id, resolutionText.trim() === '' ? undefined : resolutionText),
    onSuccess: async () => {
      setResolutionText('');
      await settled();
    },
    onError: failed('Failed to Resolve Todo'),
  });
  const dismissMutation = useMutation({
    mutationFn: () => dismissTodo(todo.id),
    onSuccess: settled,
    onError: failed('Failed to Dismiss Todo'),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteTodo(todo.id),
    onSuccess: async () => {
      setConfirmDelete(false);
      await settled();
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      onError('Failed to Delete Todo', err.message);
    },
  });
  const assignMutation = useMutation({
    mutationFn: (assigneeUserId: string | null) => updateTodo(todo.id, { assigneeUserId }),
    onSuccess: settled,
    onError: failed('Failed to Assign Todo'),
  });
  const reScopeMutation = useMutation({
    mutationFn: (patch: { scope: 'session' | 'global'; sessionId?: string }) => updateTodo(todo.id, patch),
    onSuccess: async () => {
      setAskSessionId(false);
      setSessionIdInput('');
      await settled();
    },
    onError: failed('Failed to Re-scope Todo'),
  });

  const handleResolve = () => {
    if (resolveNeedsText) return;
    resolveMutation.mutate();
  };

  const handleMakeSession = () => {
    if (todo.sessionId) {
      reScopeMutation.mutate({ scope: 'session' });
    } else {
      setAskSessionId(true);
    }
  };

  return (
    <li className="card" data-testid={`todo-${todo.id}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="min-w-0 break-words text-sm font-medium text-gray-100">{todo.title}</span>
        <div className="flex items-center gap-1.5">
          <span className={`${BADGE_CLASS} bg-blue-500/20 text-blue-300`} aria-label={`Kind: ${todo.kind}`}>
            {todo.kind}
          </span>
          <span className={`${BADGE_CLASS} bg-slate-600/60 text-gray-300`} aria-label={`Scope: ${todo.scope}`}>
            {todo.scope}
          </span>
          <span className={`${BADGE_CLASS} bg-gray-500/20 text-gray-400`} aria-label={`Status: ${todo.status}`}>
            {todo.status}
          </span>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-gray-500">
        <span>Created by {creatorLabel(todo, users)}</span>
        {todo.assigneeUserId !== null && <span>Assigned to {usernameOf(users, todo.assigneeUserId)}</span>}
        {todo.sessionId !== null && (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: todo.sessionId }}
            className="text-slate-400 hover:text-white underline"
          >
            Open session
          </Link>
        )}
      </div>

      {todo.body !== '' && (
        <div className="mt-2 text-sm text-gray-300 break-words">
          <TodoBodyMarkdown body={todo.body} focusable />
        </div>
      )}

      {todo.resolutionText && (
        <div className="mt-2 text-xs text-gray-400">
          <span className="font-medium">Resolution:</span>
          <p className="whitespace-pre-wrap break-words">{todo.resolutionText}</p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {canResolve && (
          <>
            <input
              type="text"
              aria-label={`Resolution text for ${todo.title}`}
              placeholder={
                isQuestion ? 'Answer (required)' : todo.status === 'done' ? 'Add to the resolution' : 'Resolution (optional)'
              }
              value={resolutionText}
              onChange={(e) => setResolutionText(e.target.value)}
              className="input text-sm flex-1 min-w-40"
            />
            <button
              type="button"
              onClick={handleResolve}
              disabled={resolveNeedsText || resolveMutation.isPending}
              className="btn text-xs bg-green-700 hover:bg-green-600 disabled:opacity-50"
            >
              Resolve
            </button>
          </>
        )}
        {isOpen && (
          <button
            type="button"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
            className="btn text-xs bg-slate-700 hover:bg-slate-600"
          >
            Dismiss
          </button>
        )}
        <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-danger text-xs">
          Delete
        </button>
      </div>

      {(canAssign || canReScope) && (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          {canAssign && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              Assignee
              <select
                aria-label={`Assignee for ${todo.title}`}
                value={todo.assigneeUserId ?? UNASSIGNED_VALUE}
                onChange={(e) => assignMutation.mutate(e.target.value === UNASSIGNED_VALUE ? null : e.target.value)}
                disabled={assignMutation.isPending}
                className="input text-xs"
              >
                <option value={UNASSIGNED_VALUE}>Unassigned</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.username}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canReScope && todo.scope === 'session' && (
            <button
              type="button"
              onClick={() => reScopeMutation.mutate({ scope: 'global' })}
              disabled={reScopeMutation.isPending}
              className="btn text-xs bg-slate-700 hover:bg-slate-600"
            >
              Make global
            </button>
          )}
          {canReScope && todo.scope === 'global' && !askSessionId && (
            <button
              type="button"
              onClick={handleMakeSession}
              disabled={reScopeMutation.isPending}
              className="btn text-xs bg-slate-700 hover:bg-slate-600"
            >
              Attach to a session
            </button>
          )}
          {canReScope && todo.scope === 'global' && askSessionId && (
            <span className="flex items-center gap-1.5">
              <input
                type="text"
                aria-label={`Session id for ${todo.title}`}
                placeholder="Session id"
                value={sessionIdInput}
                onChange={(e) => setSessionIdInput(e.target.value)}
                className="input text-xs"
              />
              <button
                type="button"
                onClick={() => reScopeMutation.mutate({ scope: 'session', sessionId: sessionIdInput.trim() })}
                disabled={sessionIdInput.trim() === '' || reScopeMutation.isPending}
                className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
              >
                Attach
              </button>
            </span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(false)}
        title="Delete Todo"
        description={`Are you sure you want to delete "${todo.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteMutation.mutate()}
        isLoading={deleteMutation.isPending}
      />
    </li>
  );
}
