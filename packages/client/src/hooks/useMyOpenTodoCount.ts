import { useAuth } from '../lib/auth';
import { useFilteredTodos } from './useFilteredTodos';

/**
 * Number of OPEN to-do items assigned to the current user, for the navigation
 * badge. Without a current user (single-user mode sets none) there is no
 * "me" to count for, so nothing is fetched and the count stays zero.
 *
 * The server already filters by `assignee` and `status`; the count is taken
 * over the same two predicates again so the badge never counts an item the
 * response carries for any other reason.
 */
export function useMyOpenTodoCount(): number {
  const { currentUser } = useAuth();
  const userId = currentUser?.id;
  const { data } = useFilteredTodos(
    { assignee: userId, status: 'open' },
    { enabled: userId !== undefined },
  );
  if (userId === undefined || !data) return 0;
  return data.filter((todo) => todo.status === 'open' && todo.assigneeUserId === userId).length;
}
