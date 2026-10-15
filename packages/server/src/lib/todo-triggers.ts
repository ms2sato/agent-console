/**
 * Realtime-refresh trigger for the human TODO list, shared by the REST routes
 * (`routes/todos.ts`) and the MCP tools (`create_todo` in `mcp/mcp-server.ts`).
 * `todos-updated` is trigger-only: it carries the affected item's `sessionId`
 * (null when the item has none), never content, and clients refetch.
 */
import type { AppServerMessage } from '@agent-console/shared';

export function emitTodosUpdated(
  broadcast: (msg: AppServerMessage) => void,
  sessionId: string | null,
): void {
  broadcast({ type: 'todos-updated', sessionId });
}
