import { Link } from '@tanstack/react-router';
import type { Todo, UsersListResponse } from '@agent-console/shared';
import { TodoActions } from './TodoActions';
import { usernameOf, creatorLabel } from './todo-labels';

type DirectoryUsers = UsersListResponse['users'];

const BADGE_CLASS = 'shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium leading-none';

interface TodoRowProps {
  todo: Todo;
  users: DirectoryUsers;
  /** Shows a refused or failed action; the message is the server's own. */
  onError: (title: string, message: string) => void;
  /** Opens the item's detail view (full body, history, edit, delete). */
  onOpenDetail: (todoId: string) => void;
  /** False where the host already IS the item's session (the session sidebar). */
  showSessionLink?: boolean;
  /** False while the host is collapsed: every control leaves the tab order (fallback for engines without `inert`). */
  focusable?: boolean;
}

/**
 * The summary row, used by every list of Todo items: title, badges, who
 * created / holds it, and the resolve / dismiss / assign controls. The body,
 * resolution history, editing and deleting live in the detail view.
 */
export function TodoRow({ todo, users, onError, onOpenDetail, showSessionLink = true, focusable = true }: TodoRowProps) {
  const tabIndex = focusable ? undefined : -1;
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
        {showSessionLink && todo.sessionId !== null && (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: todo.sessionId }}
            tabIndex={tabIndex}
            className="text-slate-400 hover:text-white underline"
          >
            Open session
          </Link>
        )}
        <button
          type="button"
          tabIndex={tabIndex}
          aria-label={`Open ${todo.title}`}
          onClick={() => onOpenDetail(todo.id)}
          className="text-slate-400 hover:text-white underline"
        >
          Open
        </button>
      </div>

      <TodoActions todo={todo} users={users} onError={onError} focusable={focusable} />
    </li>
  );
}
