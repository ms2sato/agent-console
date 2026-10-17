import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { canReceiveNotifications } from '@agent-console/shared';
import type { Todo, TodoActivity, TodoActivityActor, UsersListResponse } from '@agent-console/shared';
import { updateTodo, deleteTodo, commentTodo, moveTodo } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { matchesUserFilter } from '../../hooks/useSessionFilter';
import { useSessionTitles } from '../../hooks/useSessionTitles';
import { todoKeys } from '../../lib/query-keys';
import { formatAbsoluteTimestamp } from '../../lib/format';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { SectionHeader, DetailRow } from '../ui/detail-layout';
import { TodoActions } from './TodoActions';
import { TodoBodyMarkdown } from './TodoBodyMarkdown';
import { usernameOf, creatorLabel } from './todo-labels';

type DirectoryUsers = UsersListResponse['users'];

interface TodoDetailProps {
  todo: Todo;
  users: DirectoryUsers;
  /** The item's timeline in the server's order (comments and moves); rendered as sent, never re-sorted. */
  activities: TodoActivity[];
  /** Shows a refused or failed action; the message is the server's own. */
  onError: (title: string, message: string) => void;
  /** True where a terminal of the item's session can run a ```terminal block (the in-session dialog). */
  runEnabled: boolean;
  onRun?: (command: string) => void;
  /** Called after the item is deleted (the page navigates away, the dialog closes). */
  onDeleted: () => void;
}

function formatIso(iso: string): string {
  return formatAbsoluteTimestamp(Date.parse(iso));
}

/**
 * Who resolved the item, from the wire fields: a human resolved it directly
 * (no worker), an agent recorded a human's statement (worker and user), or an
 * agent recorded it with no known human. Null when nobody resolved it.
 */
function provenanceLabel(todo: Todo, users: DirectoryUsers): string | null {
  const { resolvedByWorkerId, resolvedByUserId } = todo;
  if (resolvedByWorkerId === null) {
    return resolvedByUserId === null ? null : `resolved by ${usernameOf(users, resolvedByUserId)}`;
  }
  return resolvedByUserId === null
    ? 'recorded by an agent'
    : `recorded by an agent from ${usernameOf(users, resolvedByUserId)}'s statement`;
}

function actorLabel(actor: TodoActivityActor, users: DirectoryUsers): string {
  return 'userId' in actor ? usernameOf(users, actor.userId) : 'agent';
}

const SESSION_ID_DISPLAY_LENGTH = 8;

/** The session's own label: its title, else the start of its id. */
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH);
}

interface ActivityRowProps {
  activity: TodoActivity;
  users: DirectoryUsers;
}

function ActivityRow({ activity, users }: ActivityRowProps) {
  const { titleOf } = useSessionTitles();
  // A live session is named by its title; one the list does not hold falls back to the start of its id.
  const sessionLabel = (sessionId: string | null): string =>
    sessionId === null ? 'no session' : (titleOf(sessionId) ?? shortSessionId(sessionId));
  switch (activity.kind) {
    case 'comment':
      return (
        <li data-testid={`todo-activity-${activity.id}`} className="text-sm">
          <p className="text-xs text-gray-500">
            {actorLabel(activity.actor, users)} · {formatIso(activity.createdAt)}
          </p>
          <p className="text-gray-300 whitespace-pre-wrap break-words">{activity.text}</p>
        </li>
      );
    case 'moved':
      return (
        <li data-testid={`todo-activity-${activity.id}`} className="text-sm">
          <p className="text-xs text-gray-500">
            Moved from {sessionLabel(activity.fromSessionId)} to {sessionLabel(activity.toSessionId)} by{' '}
            {actorLabel(activity.actor, users)} · {formatIso(activity.createdAt)}
          </p>
          {activity.statement !== null && (
            <p className="text-gray-300 whitespace-pre-wrap break-words">
              {activity.attributedUserId === null
                ? `on a human's instruction: "${activity.statement}"`
                : `"${activity.statement}" -- ${usernameOf(users, activity.attributedUserId)}`}
            </p>
          )}
        </li>
      );
    default: {
      const _exhaustive: never = activity;
      throw new Error(`Unhandled Todo activity: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

interface TodoReplyFormProps {
  todoId: string;
  onError: TodoDetailProps['onError'];
}

function TodoReplyForm({ todoId, onError }: TodoReplyFormProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');

  const replyMutation = useMutation({
    mutationFn: () => commentTodo(todoId, text.trim()),
    onSuccess: async () => {
      setText('');
      await queryClient.invalidateQueries({ queryKey: todoKeys.root() });
    },
    onError: (err: Error) => onError('Failed to Reply', err.message),
  });

  return (
    <div className="space-y-2 mt-3">
      <textarea
        aria-label="Reply"
        placeholder="Reply on this item"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="input text-sm w-full"
      />
      <button
        type="button"
        onClick={() => replyMutation.mutate()}
        disabled={text.trim() === '' || replyMutation.isPending}
        className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
      >
        Reply
      </button>
    </div>
  );
}

interface TodoEditFormProps {
  todo: Todo;
  onError: TodoDetailProps['onError'];
}

function TodoEditForm({ todo, onError }: TodoEditFormProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);

  const saveMutation = useMutation({
    mutationFn: () => updateTodo(todo.id, { title: title.trim(), body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.root() }),
    onError: (err: Error) => onError('Failed to Update Todo', err.message),
  });
  const unchanged = title.trim() === todo.title && body === todo.body;

  return (
    <div className="space-y-2">
      <SectionHeader title="Edit" />
      <input
        type="text"
        aria-label="Edit title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="input text-sm w-full"
      />
      <textarea
        aria-label="Edit body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        className="input text-sm w-full font-mono"
      />
      <button
        type="button"
        onClick={() => saveMutation.mutate()}
        disabled={title.trim() === '' || unchanged || saveMutation.isPending}
        className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function TodoMoveControls({ todo, onError }: TodoEditFormProps) {
  const queryClient = useQueryClient();
  const { currentUser, isMultiUser } = useAuth();
  const { sessions } = useSessionTitles();
  const [showAll, setShowAll] = useState(false);
  const [target, setTarget] = useState('');

  // Only a live session can take the item: its delivery needs a live worker.
  // An agent-created item's delivery goes to a worker of its session, so its target needs one that can receive it.
  const needsDeliveryWorker = 'workerId' in todo.createdBy;
  const live = sessions.filter(
    (session) =>
      !session.pausedAt &&
      session.id !== todo.sessionId &&
      (!needsDeliveryWorker || session.workers.some(canReceiveNotifications)),
  );
  const offered = showAll
    ? live
    : live.filter(
        (session) =>
          !isMultiUser ||
          currentUser === null ||
          matchesUserFilter(session.createdBy, currentUser.id) ||
          session.isShared,
      );
  // The choice is dropped when a widened list narrows back (or the session leaves the list).
  const chosen = offered.some((session) => session.id === target) ? target : '';

  const optionLabel = (session: (typeof live)[number]): string => {
    const label = session.title ?? shortSessionId(session.id);
    return showAll && isMultiUser && session.createdByUsername ? `${label} (${session.createdByUsername})` : label;
  };

  const moveMutation = useMutation({
    mutationFn: () => moveTodo(todo.id, { sessionId: chosen }),
    onSuccess: async () => {
      setTarget('');
      await queryClient.invalidateQueries({ queryKey: todoKeys.root() });
    },
    onError: (err: Error) => onError('Failed to Move', err.message),
  });

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <select
        aria-label="Move to session"
        value={chosen}
        onChange={(e) => setTarget(e.target.value)}
        className="input text-sm"
      >
        <option value="">Choose a session</option>
        {offered.map((session) => (
          <option key={session.id} value={session.id}>
            {optionLabel(session)}
          </option>
        ))}
      </select>
      {isMultiUser && (
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          All sessions
        </label>
      )}
      <button
        type="button"
        onClick={() => moveMutation.mutate()}
        disabled={chosen === '' || moveMutation.isPending}
        className="btn text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
      >
        Move
      </button>
    </div>
  );
}

function TodoReScopeControls({ todo, onError }: TodoEditFormProps) {
  const queryClient = useQueryClient();
  const [askSessionId, setAskSessionId] = useState(false);
  const [sessionIdInput, setSessionIdInput] = useState('');

  const reScopeMutation = useMutation({
    mutationFn: (patch: { scope: 'session' | 'global'; sessionId?: string }) => updateTodo(todo.id, patch),
    onSuccess: async () => {
      setAskSessionId(false);
      setSessionIdInput('');
      await queryClient.invalidateQueries({ queryKey: todoKeys.root() });
    },
    onError: (err: Error) => onError('Failed to Re-scope Todo', err.message),
  });

  const handleMakeSession = () => {
    if (todo.sessionId) {
      reScopeMutation.mutate({ scope: 'session' });
    } else {
      setAskSessionId(true);
    }
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {todo.scope === 'session' && (
        <button
          type="button"
          onClick={() => reScopeMutation.mutate({ scope: 'global' })}
          disabled={reScopeMutation.isPending}
          className="btn text-xs bg-slate-700 hover:bg-slate-600"
        >
          Make global
        </button>
      )}
      {todo.scope === 'global' && !askSessionId && (
        <button
          type="button"
          onClick={handleMakeSession}
          disabled={reScopeMutation.isPending}
          className="btn text-xs bg-slate-700 hover:bg-slate-600"
        >
          Attach to a session
        </button>
      )}
      {todo.scope === 'global' && askSessionId && (
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
  );
}

/**
 * One Todo item in full: every field, the full body, the resolution history
 * with its provenance, and the actions the summary row does not carry (edit,
 * re-scope, delete). Hosted by the `/todos/:id` page and the in-session dialog.
 */
export function TodoDetail({ todo, users, activities, onError, runEnabled, onRun, onDeleted }: TodoDetailProps) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isOpen = todo.status === 'open';
  // A question is always session-scoped; only an open action can be re-scoped.
  const canReScope = isOpen && todo.kind === 'action';
  const provenance = provenanceLabel(todo, users);
  // The server takes a reply on an open or done item only; a closed item keeps its timeline read-only.
  const canReply = todo.status === 'open' || todo.status === 'done';

  const deleteMutation = useMutation({
    mutationFn: () => deleteTodo(todo.id),
    onSuccess: async () => {
      setConfirmDelete(false);
      // Leave first: refetching the deleted item before the host closes would flash the deleted-state card.
      onDeleted();
      await queryClient.invalidateQueries({ queryKey: todoKeys.root() });
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      onError('Failed to Delete Todo', err.message);
    },
  });

  return (
    <div className="space-y-6" data-testid={`todo-detail-${todo.id}`}>
      <h2 className="text-lg font-semibold text-gray-100 break-words">{todo.title}</h2>

      <section>
        <SectionHeader title="Details" />
        <div className="space-y-1 text-sm">
          <DetailRow label="Kind" value={todo.kind} />
          <DetailRow label="Scope" value={todo.scope} />
          <DetailRow label="Status" value={todo.status} />
          <DetailRow label="Created by" value={creatorLabel(todo, users)} />
          {todo.assigneeUserId !== null && (
            <DetailRow label="Assigned to" value={usernameOf(users, todo.assigneeUserId)} />
          )}
          <DetailRow label="Created at" value={formatIso(todo.createdAt)} />
          {todo.resolvedAt !== null && <DetailRow label="Resolved at" value={formatIso(todo.resolvedAt)} />}
        </div>
      </section>

      {todo.body !== '' && (
        <section>
          <SectionHeader title="Body" />
          <div className="memo-content min-w-0 text-sm text-gray-300">
            <TodoBodyMarkdown body={todo.body} focusable onRun={runEnabled ? onRun : undefined} />
          </div>
        </section>
      )}

      {!runEnabled && todo.sessionId !== null && (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: todo.sessionId }}
          className="inline-block text-sm text-slate-400 hover:text-white underline"
        >
          Open in session
        </Link>
      )}

      {(activities.length > 0 || canReply) && (
        <section aria-label="Thread">
          <SectionHeader title="Thread" />
          {activities.length > 0 && (
            <ul className="space-y-3">
              {activities.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} users={users} />
              ))}
            </ul>
          )}
          {canReply && <TodoReplyForm todoId={todo.id} onError={onError} />}
        </section>
      )}

      {(todo.resolutionText || provenance !== null) && (
        <section>
          <SectionHeader title="Resolution" />
          {todo.resolutionText && (
            <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">{todo.resolutionText}</p>
          )}
          {provenance !== null && <p className="mt-1 text-xs text-gray-500">{provenance}</p>}
        </section>
      )}

      {/* Remount when the server's version changes: the inputs seed from props only on mount. */}
      {isOpen && <TodoEditForm key={`${todo.id}:${todo.updatedAt}`} todo={todo} onError={onError} />}

      {canReScope && (
        <section>
          <SectionHeader title="Scope" />
          <TodoReScopeControls todo={todo} onError={onError} />
        </section>
      )}

      {isOpen && (
        <section>
          <SectionHeader title="Move to session" />
          <TodoMoveControls todo={todo} onError={onError} />
        </section>
      )}

      <section>
        <SectionHeader title="Actions" />
        <TodoActions todo={todo} users={users} onError={onError} />
      </section>

      <div>
        <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-danger text-xs">
          Delete
        </button>
      </div>

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
    </div>
  );
}
