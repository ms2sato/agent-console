import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Todo, UsersListResponse } from '@agent-console/shared';
import { updateTodo, resolveTodo, dismissTodo } from '../../lib/api';
import { todoKeys } from '../../lib/query-keys';

type DirectoryUsers = UsersListResponse['users'];

const UNASSIGNED_VALUE = '';

interface TodoActionsProps {
  todo: Todo;
  users: DirectoryUsers;
  /** Shows a refused or failed action; the message is the server's own. */
  onError: (title: string, message: string) => void;
}

/**
 * The resolve / dismiss / assign controls of one Todo item. The single home of
 * those three mutations: the summary row and the detail view both render it.
 */
export function TodoActions({ todo, users, onError }: TodoActionsProps) {
  const queryClient = useQueryClient();
  const [resolutionText, setResolutionText] = useState('');

  const isOpen = todo.status === 'open';
  const canResolve = todo.status === 'open' || todo.status === 'done';
  const isQuestion = todo.kind === 'question';
  const resolveNeedsText = isQuestion && resolutionText.trim() === '';
  // The directory has one member in single-user mode: assignment has no meaning there.
  const canAssign = isOpen && users.length > 1;

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
  const assignMutation = useMutation({
    mutationFn: (assigneeUserId: string | null) => updateTodo(todo.id, { assigneeUserId }),
    onSuccess: settled,
    onError: failed('Failed to Assign Todo'),
  });

  const handleResolve = () => {
    if (resolveNeedsText) return;
    resolveMutation.mutate();
  };

  return (
    <>
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
      </div>

      {canAssign && (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
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
        </div>
      )}
    </>
  );
}
