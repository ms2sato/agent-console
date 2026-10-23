import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchUsers } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useSessionTodos } from './hooks/useSessionTodos';
import { AccordionSectionBody } from './AccordionSectionBody';
import { AddTodoForm } from '../todos/AddTodoForm';
import { TodoRow } from '../todos/TodoRow';
import { DEFAULT_TODO_STATUS_FILTER, TodoStatusSelect, type TodoStatusFilter } from '../todos/TodoStatusSelect';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
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
 * (`docs/design/human-todo-list.md`, section 4 "UI"): a New Todo button that
 * opens a dialog with the add form (session preset), a status filter select
 * (open by default, not remembered), then one summary row per item of the
 * chosen status (both scopes). A row's title shows the item's detail in a
 * dialog over the session page. The header count is the number of OPEN items
 * only, whatever the filter. The block renders nothing until the first fetch
 * settles, and renders with zero items afterwards so an empty session can
 * still receive one.
 */
export function SessionTodosPanel({ sessionId, isExpanded, onToggleExpanded, compact }: SessionTodosPanelProps) {
  const { todos, openCount, isPending, isError, refetch } = useSessionTodos(sessionId);
  const { data: users = [] } = useQuery({ queryKey: userKeys.list(), queryFn: fetchUsers });
  const { errorDialogProps, showError } = useErrorDialog();
  const [openTodoId, setOpenTodoId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TodoStatusFilter>(DEFAULT_TODO_STATUS_FILTER);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Each opening of the New Todo dialog mounts a fresh form. A create started in an earlier opening can finish
  // after that dialog was cancelled and reopened; its onCreated must not close the reopened dialog.
  const addGenerationRef = useRef(0);
  const formGeneration = addGenerationRef.current;
  const handleAddOpenChange = (open: boolean) => {
    if (open) addGenerationRef.current += 1;
    setAddOpen(open);
  };

  const handleOpenDetail = (todoId: string) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenTodoId(todoId);
  };

  // The dialog has no trigger element, so return focus to the control that opened it;
  // when that row is gone (the item was deleted) fall back to the New Todo button.
  const handleDialogCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    const opener = openerRef.current;
    openerRef.current = null;
    const target =
      opener !== null && opener.isConnected && panelRef.current?.contains(opener)
        ? opener
        : panelRef.current?.querySelector<HTMLElement>('button[aria-label="New Todo"]');
    target?.focus();
  };

  // Radix focuses the first tabbable control (the Kind select); the Title is what the human types first.
  const handleAddOpenAutoFocus = (event: Event) => {
    const content = event.currentTarget;
    const title = content instanceof HTMLElement ? content.querySelector<HTMLElement>('input[aria-label="Title"]') : null;
    if (title) {
      event.preventDefault();
      title.focus();
    }
  };

  if (isPending) {
    return null;
  }

  // A failed fetch has no count to report: showing "(0)" would read as "nothing to do".
  const visibleTodos = todos.filter((todo) => statusFilter === 'all' || todo.status === statusFilter);
  const emptyLabel = statusFilter === 'all' ? 'No items' : `No ${statusFilter} items`;

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
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-700/50">
            <Dialog open={addOpen} onOpenChange={handleAddOpenChange}>
              <DialogTrigger
                tabIndex={isExpanded ? undefined : -1}
                aria-label="New Todo"
                className="btn btn-primary text-sm"
              >
                New Todo
              </DialogTrigger>
              <DialogContent aria-describedby={undefined} onOpenAutoFocus={handleAddOpenAutoFocus}>
                <DialogHeader>
                  <DialogTitle>New Todo</DialogTitle>
                </DialogHeader>
                <AddTodoForm
                  users={users}
                  sessionId={sessionId}
                  hideSessionField
                  onError={showError}
                  onCreated={() => {
                    if (formGeneration === addGenerationRef.current) setAddOpen(false);
                  }}
                />
                <DialogClose className="btn text-sm mt-2">Cancel</DialogClose>
              </DialogContent>
            </Dialog>
            <TodoStatusSelect value={statusFilter} onChange={setStatusFilter} focusable={isExpanded} />
          </div>
          {!isError && visibleTodos.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">{emptyLabel}</p>}
          <ul className="flex flex-col gap-2 list-none p-2 m-0">
            {visibleTodos.map((todo) => (
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
