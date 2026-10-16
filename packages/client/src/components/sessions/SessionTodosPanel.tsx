import { useState } from 'react';
import type { Todo } from '@agent-console/shared';
import { useSessionTodos } from './hooks/useSessionTodos';
import { AccordionSectionBody } from './AccordionSectionBody';
import { TodoBodyMarkdown } from '../todos/TodoBodyMarkdown';
import { useSessionTerminalRun } from './SessionTerminalRunContext';
import { RunCommandDialog } from './RunCommandDialog';

interface SessionTodosPanelProps {
  sessionId: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  compact: boolean;
}

const BADGE_CLASS = 'shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium leading-none';

function TodoItem({
  todo,
  isExpanded,
  onRun,
}: {
  todo: Todo;
  isExpanded: boolean;
  onRun: ((command: string) => void) | undefined;
}) {
  return (
    <div className="px-3 py-2 border-b border-slate-700/50">
      <div className="flex items-start gap-1.5 flex-wrap">
        <span className="min-w-0 break-words text-sm text-gray-200">{todo.title}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1">
        <span className={`${BADGE_CLASS} bg-slate-600/60 text-gray-300`} aria-label={`Scope: ${todo.scope}`}>
          {todo.scope}
        </span>
        <span className={`${BADGE_CLASS} bg-blue-500/20 text-blue-300`} aria-label={`Kind: ${todo.kind}`}>
          {todo.kind}
        </span>
        {todo.status !== 'open' && (
          <span className={`${BADGE_CLASS} bg-gray-500/20 text-gray-400`} aria-label={`Status: ${todo.status}`}>
            {todo.status}
          </span>
        )}
      </div>
      {todo.body !== '' && (
        <div className="mt-1 text-sm text-gray-300 break-words">
          <TodoBodyMarkdown body={todo.body} focusable={isExpanded} onRun={onRun} />
        </div>
      )}
      {todo.resolutionText && (
        <p className="mt-1 text-xs text-gray-400 whitespace-pre-wrap break-words">{todo.resolutionText}</p>
      )}
    </div>
  );
}

/**
 * Read-only list of the to-do items attached to this session, presented
 * alongside `MemoPanel` (`docs/design/human-todo-list.md`, section 4 "UI",
 * item (a)). Lists every item whose `sessionId` is this session, both scopes;
 * the header count is the number of OPEN items only. The whole block renders
 * nothing while there are zero open items (or before the first fetch
 * resolves), so a session with nothing to do carries no extra chrome.
 */
export function SessionTodosPanel({ sessionId, isExpanded, onToggleExpanded, compact }: SessionTodosPanelProps) {
  const { todos, openCount } = useSessionTodos(sessionId);
  const [pendingRunCommand, setPendingRunCommand] = useState<string | null>(null);
  const terminalRun = useSessionTerminalRun();

  if (openCount === 0) {
    return null;
  }

  if (compact) {
    return (
      <button
        onClick={onToggleExpanded}
        className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
        title="Expand Todo"
        aria-label="Expand Todo"
      >
        <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>Todo ({openCount})</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col border-b border-slate-700">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse Todo' : 'Expand Todo'}
          className="text-sm font-medium text-gray-300 bg-transparent border-none p-0 cursor-pointer text-left"
        >
          Todo ({openCount})
        </button>
      </div>
      <AccordionSectionBody isExpanded={isExpanded}>
        <div className="min-w-0 max-h-96 overflow-y-auto">
          {todos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              isExpanded={isExpanded}
              onRun={terminalRun ? setPendingRunCommand : undefined}
            />
          ))}
        </div>
      </AccordionSectionBody>
      {terminalRun && pendingRunCommand !== null && (
        <RunCommandDialog
          sessionId={sessionId}
          command={pendingRunCommand}
          terminalRun={terminalRun}
          onClose={() => setPendingRunCommand(null)}
        />
      )}
    </div>
  );
}
