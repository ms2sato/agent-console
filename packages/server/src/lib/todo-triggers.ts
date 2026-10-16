/**
 * Triggers that follow a write to the human TODO list, shared by the REST
 * routes (`routes/todos.ts`) and the MCP tools (`create_todo` in
 * `mcp/mcp-server.ts`):
 *
 * - `emitTodosUpdated`: the app broadcast. `todos-updated` is trigger-only: it
 *   carries the affected item's `sessionId` (null when the item has none),
 *   never content, and clients refetch.
 * - `deliverTodoResolution`: the notification to the worker that created the
 *   item, sent when a human resolves it.
 *
 * Dismiss, delete, supersede and withdraw deliver nothing to the creating
 * worker, by design.
 */
import type { AppServerMessage, Todo } from '@agent-console/shared';
import type { SessionManager, WorkerNotificationResult } from '../services/session-manager.js';

export const TODO_RESOLUTION_NOTIFICATION_MAX_CHARS = 500;

export function emitTodosUpdated(
  broadcast: (msg: AppServerMessage) => void,
  sessionId: string | null,
): void {
  broadcast({ type: 'todos-updated', sessionId });
}

/**
 * Notify the creating worker that its item was resolved with `resolutionText`
 * (this call's text, not the item's accumulated resolution). A human-created
 * item has no worker: resolves to `undefined` without touching the seam.
 */
export async function deliverTodoResolution(
  deps: Pick<SessionManager, 'deliverWorkerNotification'>,
  todo: Todo,
  resolutionText: string,
): Promise<WorkerNotificationResult | undefined> {
  if (!('workerId' in todo.createdBy) || todo.sessionId === null) return undefined;

  const resolution =
    resolutionText.length > TODO_RESOLUTION_NOTIFICATION_MAX_CHARS
      ? `${resolutionText.slice(0, TODO_RESOLUTION_NOTIFICATION_MAX_CHARS)}...`
      : resolutionText;

  return deps.deliverWorkerNotification(todo.sessionId, todo.createdBy.workerId, {
    kind: 'internal-todo-resolved',
    tag: 'internal:todo-resolved',
    fields: { todoId: todo.id, todoKind: todo.kind, title: todo.title, resolution },
    intent: 'triage',
  });
}
