import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { ButtonSpinner } from '../ui/Spinner';
import { sendWorkerMessage } from '../../lib/api';
import { logger } from '../../lib/logger';
import type { SessionTerminalRun } from './SessionTerminalRunContext';

export interface RunCommandDialogProps {
  sessionId: string;
  /** The exact command text (equal to what Copy puts on the clipboard). */
  command: string;
  terminalRun: SessionTerminalRun;
  onClose: () => void;
}

// Mounted only while a Run is pending, so the selection and error state start
// fresh for every command.
export function RunCommandDialog({ sessionId, command, terminalRun, onClose }: RunCommandDialogProps) {
  const { terminalWorkers, activateWorker, createTerminalWorker } = terminalRun;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived each render so a worker removed on the server cannot stay selected.
  const target = terminalWorkers.find((w) => w.id === selectedId) ?? terminalWorkers[0] ?? null;

  const handleConfirm = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setError(null);
    try {
      let workerId: string;
      if (target) {
        workerId = target.id;
      } else {
        const created = await createTerminalWorker();
        if (!created) {
          // createTerminalWorker has already surfaced the failure.
          onClose();
          return;
        }
        workerId = created.id;
      }
      await sendWorkerMessage(sessionId, workerId, command);
      // A freshly created terminal is already the active tab.
      if (target) activateWorker(workerId);
      onClose();
    } catch (err) {
      logger.error('Failed to run command in terminal:', err);
      setError(err instanceof Error ? err.message : 'Failed to run command');
      setIsRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isRunning) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run in terminal?</DialogTitle>
          <DialogDescription>
            This command will be typed into the terminal and executed. Read it before confirming.
          </DialogDescription>
        </DialogHeader>
        <pre
          data-testid="run-command-text"
          className="text-sm text-gray-200 bg-slate-900 rounded p-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono"
        >
          {command}
        </pre>
        <div className="mt-3 text-sm text-gray-300">
          {terminalWorkers.length === 0 ? (
            <span data-testid="run-command-target">A new terminal will be created in this session.</span>
          ) : terminalWorkers.length === 1 ? (
            <span>
              Target terminal: <span data-testid="run-command-target" className="font-medium text-white">{terminalWorkers[0].name}</span>
            </span>
          ) : (
            <label className="flex items-center gap-2">
              Target terminal:
              <select
                aria-label="Target terminal"
                value={target?.id ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={isRunning}
                className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-200"
              >
                {terminalWorkers.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
        <DialogFooter>
          <button type="button" onClick={onClose} disabled={isRunning} className="btn bg-slate-600 hover:bg-slate-500">
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={isRunning} className="btn btn-primary">
            <ButtonSpinner isPending={isRunning} pendingText="Running...">
              Run
            </ButtonSpinner>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
