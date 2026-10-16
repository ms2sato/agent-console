import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TODO_KINDS, TODO_SCOPES, type TodoKind, type TodoScope, type UsersListResponse } from '@agent-console/shared';
import { createTodo } from '../../lib/api';
import { todoKeys } from '../../lib/query-keys';

interface AddTodoFormProps {
  users: UsersListResponse['users'];
  /** Session ids offered as suggestions for the optional session field. */
  knownSessionIds: string[];
  onError: (title: string, message: string) => void;
}

/** The scope sent when the human does not choose one: the server derives it from the session. */
const DEFAULT_SCOPE = '';
const UNASSIGNED_VALUE = '';

export function AddTodoForm({ users, knownSessionIds, onError }: AddTodoFormProps) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TodoKind>('action');
  const [scope, setScope] = useState<TodoScope | typeof DEFAULT_SCOPE>(DEFAULT_SCOPE);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [assigneeUserId, setAssigneeUserId] = useState(UNASSIGNED_VALUE);

  const canAssign = users.length > 1;

  const mutation = useMutation({
    mutationFn: () =>
      createTodo({
        kind,
        scope: scope === DEFAULT_SCOPE ? undefined : scope,
        title: title.trim(),
        body,
        sessionId: sessionId.trim() === '' ? undefined : sessionId.trim(),
        assigneeUserId: canAssign && assigneeUserId !== UNASSIGNED_VALUE ? assigneeUserId : undefined,
      }),
    onSuccess: async () => {
      setTitle('');
      setBody('');
      setSessionId('');
      setScope(DEFAULT_SCOPE);
      setAssigneeUserId(UNASSIGNED_VALUE);
      await queryClient.invalidateQueries({ queryKey: todoKeys.root() });
    },
    onError: (err: Error) => onError('Failed to Add Todo', err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim() === '') return;
    mutation.mutate();
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Add Todo" className="card mb-6 flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap">
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as TodoKind)}
          className="input text-sm"
        >
          {TODO_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input text-sm flex-1 min-w-48"
        />
      </div>
      <textarea
        aria-label="Body"
        placeholder="Details (markdown)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="input text-sm"
      />
      <div className="flex gap-2 flex-wrap items-center">
        <input
          type="text"
          aria-label="Session id"
          placeholder="Session id (optional)"
          list="todo-known-sessions"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="input text-sm"
        />
        <datalist id="todo-known-sessions">
          {knownSessionIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <select
          aria-label="Scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as TodoScope | typeof DEFAULT_SCOPE)}
          className="input text-sm"
        >
          <option value={DEFAULT_SCOPE}>Scope: automatic</option>
          {TODO_SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {canAssign && (
          <select
            aria-label="Assignee"
            value={assigneeUserId}
            onChange={(e) => setAssigneeUserId(e.target.value)}
            className="input text-sm"
          >
            <option value={UNASSIGNED_VALUE}>Unassigned</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.username}
              </option>
            ))}
          </select>
        )}
        <button
          type="submit"
          disabled={title.trim() === '' || mutation.isPending}
          className="btn btn-primary text-sm ml-auto disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </form>
  );
}
