import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchUsers } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useSessionTodos } from './hooks/useSessionTodos';
import { AccordionSectionBody } from './AccordionSectionBody';
import { AddTodoForm } from '../todos/AddTodoForm';
import { TodoRow } from '../todos/TodoRow';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { TodoDetailDialog } from './TodoDetailDialog';

interface SessionTodosPanelProps {
  sessionId: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  compact: boolean;
}

/**
 * The Todo items attached to this session, presented alongside `MemoPanel`
 * (`docs/design/human-todo-list.md`, section 4 "UI"): a compact add form that
 * presets this session, then one summary row per item (both scopes). "Open"
 * shows the item's detail in a dialog over the session page. The header count
 * is the number of OPEN items only. The block renders nothing until the first
 * fetch settles, and renders with zero items afterwards so an empty session
 * can still receive one.
 */
export function SessionTodosPanel({ sessionId, isExpanded, onToggleExpanded, compact }: SessionTodosPanelProps) {
  const { todos, openCount, isPending, isError, refetch } = useSessionTodos(sessionId);
  const { data: users = [] } = useQuery({ queryKey: userKeys.list(), queryFn: fetchUsers });
  const { errorDialogProps, showError } = useErrorDialog();
  const [openTodoId, setOpenTodoId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const handleOpenDetail = (todoId: string) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenTodoId(todoId);
  };

  // The dialog has no trigger element, so return focus to the control that opened it;
  // when that row is gone (the item was deleted) fall back to the add form's title input.
  const handleDialogCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    const opener = openerRef.current;
    openerRef.current = null;
    const target =
      opener !== null && opener.isConnected && panelRef.current?.contains(opener)
        ? opener
        : panelRef.current?.querySelector<HTMLElement>('input[aria-label="Title"]');
    target?.focus();
  };

  if (isPending) {
    return null;
  }

  // A failed fetch has no count to report: showing "(0)" would read as "nothing to do".
  const headerLabel = isError ? 'Todo' : `Todo (${openCount})`;

  if (compact) {
    return (
      <button
        onClick={onToggleExpanded}
        className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
        title="Expand Todo"
        aria-label="Expand Todo"
      >
        <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>{headerLabel}</span>
      </button>
    );
  }

  return (
    <div ref={panelRef} className="flex flex-col border-b border-slate-700">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse Todo' : 'Expand Todo'}
          className="text-sm font-medium text-gray-300 bg-transparent border-none p-0 cursor-pointer text-left"
        >
          {headerLabel}
        </button>
      </div>
      <AccordionSectionBody isExpanded={isExpanded}>
        <div className="min-w-0 max-h-96 overflow-y-auto">
          {isError && (
            <div className="flex items-center gap-2 px-3 py-1.5">
              <p className="text-xs text-red-400">Failed to load Todo items</p>
              <button
                type="button"
                onClick={() => void refetch()}
                tabIndex={isExpanded ? undefined : -1}
                className="text-xs text-gray-300 hover:text-white bg-transparent border border-slate-600 rounded px-2 py-0.5 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}
          <AddTodoForm users={users} sessionId={sessionId} hideSessionField onError={showError} focusable={isExpanded} />
          <ul className="flex flex-col gap-2 list-none p-2 m-0">
            {todos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                users={users}
                onError={showError}
                onOpenDetail={handleOpenDetail}
                showSessionLink={false}
                focusable={isExpanded}
              />
            ))}
          </ul>
        </div>
      </AccordionSectionBody>
      <TodoDetailDialog
        todoId={openTodoId}
        sessionId={sessionId}
        users={users}
        onClose={() => setOpenTodoId(null)}
        onCloseAutoFocus={handleDialogCloseAutoFocus}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
