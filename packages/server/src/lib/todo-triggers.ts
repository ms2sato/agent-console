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
 * - `deliverTodoComment`: the notification to the worker that created the
 *   item, sent when a human comments on it.
 *
 * Dismiss, delete, supersede, withdraw and an agent's own comment deliver
 * nothing to the creating worker, by design.
 */
import type { AppServerMessage, Todo } from '@agent-console/shared';
import type { SessionManager, WorkerNotificationResult } from '../services/session-manager.js';

export const TODO_RESOLUTION_NOTIFICATION_MAX_CHARS = 500;
export const TODO_COMMENT_NOTIFICATION_MAX_CHARS = 500;

function capNotificationText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

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

  const resolution = capNotificationText(resolutionText, TODO_RESOLUTION_NOTIFICATION_MAX_CHARS);

  return deps.deliverWorkerNotification(todo.sessionId, todo.createdBy.workerId, {
    kind: 'internal-todo-resolved',
    tag: 'internal:todo-resolved',
    fields: { todoId: todo.id, todoKind: todo.kind, title: todo.title, resolution },
    intent: 'triage',
  });
}

/**
 * Notify the worker that created the item that `author` commented on it. A
 * human-created item has no worker, and an item without a session has nowhere
 * to deliver: both resolve to `undefined` without touching the seam. Only a
 * human's comment is delivered; an agent's comment is read by the human on the
 * item's detail and is never passed here.
 */
export async function deliverTodoComment(
  deps: Pick<SessionManager, 'deliverWorkerNotification'>,
  todo: Todo,
  author: string,
  commentText: string,
): Promise<WorkerNotificationResult | undefined> {
  if (!('workerId' in todo.createdBy) || todo.sessionId === null) return undefined;

  const text = capNotificationText(commentText, TODO_COMMENT_NOTIFICATION_MAX_CHARS);

  return deps.deliverWorkerNotification(todo.sessionId, todo.createdBy.workerId, {
    kind: 'internal-todo-comment',
    tag: 'internal:todo-comment',
    fields: { todoId: todo.id, todoKind: todo.kind, title: todo.title, author, text },
    intent: 'triage',
  });
}
