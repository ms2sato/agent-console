import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TODO_KINDS, TODO_SCOPES, type TodoKind, type TodoScope, type UsersListResponse } from '@agent-console/shared';
import { createTodo } from '../../lib/api';
import { todoKeys } from '../../lib/query-keys';

interface AddTodoFormBaseProps {
  users: UsersListResponse['users'];
  onError: (title: string, message: string) => void;
  /** False while the host is collapsed: every control leaves the tab order (fallback for engines without `inert`). */
  focusable?: boolean;
}

/** The `/todos` page form: a free session field, an explicit scope choice. */
interface GlobalAddTodoFormProps extends AddTodoFormBaseProps {
  /** Session ids offered as suggestions for the optional session field. */
  knownSessionIds: string[];
  sessionId?: undefined;
  hideSessionField?: undefined;
}

/** The session sidebar form: the session is preset, so the item is always session-scoped. */
interface SessionAddTodoFormProps extends AddTodoFormBaseProps {
  sessionId: string;
  hideSessionField: true;
  knownSessionIds?: undefined;
}

type AddTodoFormProps = GlobalAddTodoFormProps | SessionAddTodoFormProps;

/** The scope sent when the human does not choose one: the server derives it from the session. */
const DEFAULT_SCOPE = '';
const UNASSIGNED_VALUE = '';

export function AddTodoForm({ users, knownSessionIds = [], sessionId: presetSessionId, hideSessionField, onError, focusable = true }: AddTodoFormProps) {
  const tabIndex = focusable ? undefined : -1;
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TodoKind>('action');
  const [scope, setScope] = useState<TodoScope | typeof DEFAULT_SCOPE>(DEFAULT_SCOPE);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sessionIdInput, setSessionIdInput] = useState('');
  const [assigneeUserId, setAssigneeUserId] = useState(UNASSIGNED_VALUE);

  const canAssign = users.length > 1;
  const isPreset = presetSessionId !== undefined;

  const mutation = useMutation({
    mutationFn: () =>
      createTodo({
        kind,
        scope: isPreset ? 'session' : scope === DEFAULT_SCOPE ? undefined : scope,
        title: title.trim(),
        body,
        sessionId: isPreset ? presetSessionId : sessionIdInput.trim() === '' ? undefined : sessionIdInput.trim(),
        assigneeUserId: canAssign && assigneeUserId !== UNASSIGNED_VALUE ? assigneeUserId : undefined,
      }),
    onSuccess: async () => {
      setTitle('');
      setBody('');
      setSessionIdInput('');
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
    <form
      onSubmit={handleSubmit}
      aria-label="Add Todo"
      className={isPreset ? 'px-3 py-2 border-b border-slate-700/50 flex flex-col gap-2' : 'card mb-6 flex flex-col gap-2'}
    >
      <div className="flex gap-2 flex-wrap">
        <select
          tabIndex={tabIndex}
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
          tabIndex={tabIndex}
          type="text"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input text-sm flex-1 min-w-48"
        />
      </div>
      <textarea
        tabIndex={tabIndex}
        aria-label="Body"
        placeholder="Details (markdown)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={isPreset ? 2 : 3}
        className="input text-sm"
      />
      <div className="flex gap-2 flex-wrap items-center">
        {!hideSessionField && (
          <>
            <input
              tabIndex={tabIndex}
              type="text"
              aria-label="Session id"
              placeholder="Session id (optional)"
              list="todo-known-sessions"
              value={sessionIdInput}
              onChange={(e) => setSessionIdInput(e.target.value)}
              className="input text-sm"
            />
            <datalist id="todo-known-sessions">
              {knownSessionIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </>
        )}
        {!isPreset && (
          <select
            tabIndex={tabIndex}
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
        )}
        {canAssign && (
          <select
            tabIndex={tabIndex}
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
          tabIndex={tabIndex}
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
