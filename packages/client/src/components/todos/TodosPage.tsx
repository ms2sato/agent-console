import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TODO_STATUSES, type Todo, type TodoStatus } from '@agent-console/shared';
import { fetchUsers } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useAuth } from '../../lib/auth';
import { useFilteredTodos } from '../../hooks/useFilteredTodos';
import { PageBreadcrumb } from '../PageBreadcrumb';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { Spinner } from '../ui/Spinner';
import { AddTodoForm } from './AddTodoForm';
import { TodoRow } from './TodoRow';

type StatusFilter = TodoStatus | 'all';

/** Assignee filter values besides a user id. */
const ANYONE = 'anyone';
const UNASSIGNED = 'unassigned';
const ALL_SESSIONS = 'all';

const DEFAULT_STATUS_FILTER: StatusFilter = 'open';

function sessionIdsOf(todos: Todo[]): string[] {
  const ids = new Set<string>();
  for (const todo of todos) {
    if (todo.sessionId !== null) ids.add(todo.sessionId);
  }
  return [...ids].sort();
}

export function TodosPage() {
  const { errorDialogProps, showError } = useErrorDialog();
  const { currentUser } = useAuth();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(DEFAULT_STATUS_FILTER);
  const [assigneeFilter, setAssigneeFilter] = useState<string>(ANYONE);
  const [sessionFilter, setSessionFilter] = useState<string>(ALL_SESSIONS);

  const { data: users = [] } = useQuery({ queryKey: userKeys.list(), queryFn: fetchUsers });

  // Status and a concrete assignee narrow the fetch on the server. "Unassigned"
  // and the session filter have no server parameter, so they narrow the
  // fetched list here.
  const serverAssignee = assigneeFilter === ANYONE || assigneeFilter === UNASSIGNED ? undefined : assigneeFilter;
  const {
    data: todos,
    isLoading,
    error,
    refetch,
  } = useFilteredTodos({
    status: statusFilter === 'all' ? undefined : statusFilter,
    assignee: serverAssignee,
  });

  const fetched = todos ?? [];
  const sessionOptions = sessionIdsOf(fetched);
  if (sessionFilter !== ALL_SESSIONS && !sessionOptions.includes(sessionFilter)) {
    sessionOptions.push(sessionFilter);
  }
  const visible = fetched.filter(
    (todo) =>
      (assigneeFilter !== UNASSIGNED || todo.assigneeUserId === null) &&
      (sessionFilter === ALL_SESSIONS || todo.sessionId === sessionFilter),
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[{ label: 'Agent Console', to: '/' }, { label: 'To-do' }]} />

      <h1 className="text-2xl font-semibold mb-6">To-do</h1>

      <AddTodoForm users={users} knownSessionIds={sessionIdsOf(fetched)} onError={showError} />

      <div className="flex gap-3 flex-wrap mb-4 text-sm">
        <label className="flex items-center gap-1.5 text-gray-400">
          Status
          <select
            aria-label="Status filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="input text-sm"
          >
            <option value="all">All</option>
            {TODO_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Assignee
          <select
            aria-label="Assignee filter"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            className="input text-sm"
          >
            <option value={ANYONE}>Anyone</option>
            <option value={UNASSIGNED}>Unassigned</option>
            {currentUser && <option value={currentUser.id}>Me</option>}
            {users
              .filter((user) => user.id !== currentUser?.id)
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                </option>
              ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Session
          <select
            aria-label="Session filter"
            value={sessionFilter}
            onChange={(e) => setSessionFilter(e.target.value)}
            className="input text-sm"
          >
            <option value={ALL_SESSIONS}>All sessions</option>
            {sessionOptions.map((id) => (
              <option key={id} value={id}>
                {id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading to-do items...</span>
        </div>
      )}

      {!isLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load to-do items</p>
          <button onClick={() => refetch()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && visible.length > 0 && (
        <ul className="flex flex-col gap-3 list-none p-0 m-0">
          {visible.map((todo) => (
            <TodoRow key={todo.id} todo={todo} users={users} onError={showError} />
          ))}
        </ul>
      )}

      {!isLoading && !error && visible.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500">No to-do items found</p>
        </div>
      )}

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
