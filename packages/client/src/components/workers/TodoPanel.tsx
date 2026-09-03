import { useMemo } from 'react';
import { SDK_TODO_WRITE_TOOL_NAME } from '@agent-console/shared';
import type { EmbeddedAgentChatEntry } from './embedded-agent-store.js';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

const TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed'];

/**
 * Defensive re-validation of a `TodoWrite` tool-call's `args`, which is typed
 * `unknown` on the wire (`v.unknown()` in the shared schema -- tool args are
 * not validated at that layer). The real producers (the SDK's native
 * `TodoWrite` and our own valibot-validated `todo-write.ts`) always emit a
 * shape that passes this check, so failure here is not expected in practice
 * -- it exists only so a hypothetically malformed historical row fails
 * closed (hidden panel) instead of throwing and breaking the transcript.
 */
function parseTodos(args: unknown): TodoItem[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;

  const parsed: TodoItem[] = [];
  for (const item of todos) {
    if (typeof item !== 'object' || item === null) return null;
    const { content, status, activeForm } = item as Record<string, unknown>;
    if (typeof content !== 'string' || typeof activeForm !== 'string') return null;
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoItem['status'])) {
      return null;
    }
    parsed.push({ content, status: status as TodoItem['status'], activeForm });
  }
  return parsed;
}

/**
 * Finds the latest `TodoWrite` tool-call entry whose result succeeded,
 * scanning from the end of `entries` backwards. A later `TodoWrite` call
 * whose own result is `ok: false` (or still pending, `result === null`) does
 * NOT replace the currently-displayed list -- scanning continues past it to
 * find the latest *successful* call.
 *
 * Matches either the plain `'TodoWrite'` name (the `openai-api` builtin) or
 * `SDK_TODO_WRITE_TOOL_NAME` (`'mcp__console__TodoWrite'`, the `claude-sdk`
 * arm's MCP-served name on the same `console` server that also serves
 * `Compact`) -- no other tool name drives this panel.
 */
function findLatestTodos(entries: EmbeddedAgentChatEntry[]): TodoItem[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.kind !== 'tool-call' ||
      (entry.name !== 'TodoWrite' && entry.name !== SDK_TODO_WRITE_TOOL_NAME)
    ) {
      continue;
    }
    if (entry.result?.ok !== true) continue;
    const todos = parseTodos(entry.args);
    if (todos !== null) return todos;
  }
  return null;
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
};

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
};

/**
 * Read-only progress panel for the `TodoWrite` builtin tool. Pure
 * derivation of `entries` -- no store field, no wire event of its own.
 * Hidden entirely until the transcript contains at least one successful
 * `TodoWrite` call.
 */
export function TodoPanel({ entries }: { entries: EmbeddedAgentChatEntry[] }) {
  const todos = useMemo(() => findLatestTodos(entries), [entries]);

  if (todos === null || todos.length === 0) return null;

  const total = todos.length;
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const allCompleted = total > 0 && completedCount === total;

  return (
    <details
      open={!allCompleted}
      className="px-4 py-1.5 shrink-0 bg-slate-800/60 border-t border-slate-700 text-xs text-gray-400"
    >
      <summary className="cursor-pointer">
        Tasks ({completedCount}/{total} completed)
      </summary>
      <ul className="mt-1.5 space-y-1">
        {todos.map((todo, index) => (
          <li
            key={index}
            className={`flex items-start gap-1.5 ${
              todo.status === 'completed' ? 'line-through text-gray-500' : 'text-gray-300'
            }`}
          >
            <span aria-hidden="true">{STATUS_GLYPH[todo.status]}</span>
            <span className="sr-only">{STATUS_LABEL[todo.status]}</span>
            <span>{todo.status === 'in_progress' ? todo.activeForm : todo.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
