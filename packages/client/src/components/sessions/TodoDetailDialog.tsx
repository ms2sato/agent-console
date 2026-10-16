import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { UsersListResponse } from '@agent-console/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ErrorDialog, useErrorDialog } from '../ui/error-dialog';
import { Spinner } from '../ui/Spinner';
import { TodoDetail } from '../todos/TodoDetail';
import { isTodoGone, useTodoDetail } from '../../hooks/useTodoDetail';
import { useSessionTerminalRun } from './SessionTerminalRunContext';
import { RunCommandDialog } from './RunCommandDialog';

interface TodoDetailDialogProps {
  /** The item to show; null keeps the dialog closed. */
  todoId: string | null;
  sessionId: string;
  users: UsersListResponse['users'];
  onClose: () => void;
}

interface TodoDetailDialogBodyProps {
  todoId: string;
  sessionId: string;
  users: UsersListResponse['users'];
  onClose: () => void;
}

// Mounted only while a dialog is open and keyed on the item, so the detail
// query, the Run selection and the error state start fresh per item.
function TodoDetailDialogBody({ todoId, sessionId, users, onClose }: TodoDetailDialogBodyProps) {
  const { data: todo, error } = useTodoDetail(todoId);
  const terminalRun = useSessionTerminalRun();
  const [pendingRunCommand, setPendingRunCommand] = useState<string | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  return (
    <>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader className="mb-4 flex-row items-center gap-3 space-y-0 pr-8">
          <DialogTitle>Todo</DialogTitle>
          <Link
            to="/todos/$todoId"
            params={{ todoId }}
            className="text-sm text-slate-400 hover:text-white underline"
          >
            Open as page
          </Link>
        </DialogHeader>
        {todo ? (
          <TodoDetail
            todo={todo}
            users={users}
            onError={showError}
            runEnabled={terminalRun !== null}
            onRun={setPendingRunCommand}
            onDeleted={onClose}
          />
        ) : isTodoGone(error) ? (
          <p className="text-sm text-gray-400">This Todo was deleted or does not exist</p>
        ) : error ? (
          <p className="text-sm text-red-400">{error.message}</p>
        ) : (
          <div className="flex items-center gap-2 text-gray-500">
            <Spinner size="sm" />
            <span>Loading Todo...</span>
          </div>
        )}
      </DialogContent>
      {terminalRun && pendingRunCommand !== null && (
        <RunCommandDialog
          sessionId={sessionId}
          command={pendingRunCommand}
          terminalRun={terminalRun}
          onClose={() => setPendingRunCommand(null)}
        />
      )}
      <ErrorDialog {...errorDialogProps} />
    </>
  );
}

/**
 * The in-session view of one Todo item (the sidebar's "Open"): a modal over
 * the session page, so the terminal behind it stays mounted. It owns the Run
 * wiring for ```terminal blocks, which only a session page can offer.
 */
export function TodoDetailDialog({ todoId, sessionId, users, onClose }: TodoDetailDialogProps) {
  return (
    <Dialog open={todoId !== null} onOpenChange={(open) => !open && onClose()}>
      {todoId !== null && (
        <TodoDetailDialogBody key={todoId} todoId={todoId} sessionId={sessionId} users={users} onClose={onClose} />
      )}
    </Dialog>
  );
}
