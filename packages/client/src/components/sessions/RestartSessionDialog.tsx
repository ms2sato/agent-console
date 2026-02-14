import { useState, useEffect } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { restartAgentWorker, getSession } from '../../lib/api';
import { AgentSelector } from '../AgentSelector';

export interface RestartSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentAgentId?: string;
  currentBranch?: string;
  isWorktreeSession?: boolean;
  onSessionRestart?: () => void;
  onBranchChange?: (newBranch: string) => void;
}

export function RestartSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentAgentId,
  currentBranch,
  isWorktreeSession,
  onSessionRestart,
  onBranchChange,
}: RestartSessionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(currentAgentId);
  const [branchValue, setBranchValue] = useState(currentBranch ?? '');

  // Reset selected agent and branch when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedAgentId(currentAgentId);
      setBranchValue(currentBranch ?? '');
    }
  }, [open, currentAgentId, currentBranch]);

  const isAgentChanged = selectedAgentId !== currentAgentId;
  const isBranchChanged = isWorktreeSession === true && branchValue.trim() !== (currentBranch ?? '');

  const handleRestart = async (continueConversation: boolean) => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Get the session to find the first agent worker
      const session = await getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      const agentWorker = session.workers.find(w => w.type === 'agent');
      if (!agentWorker) {
        throw new Error('No agent worker found');
      }
      const agentId = isAgentChanged ? selectedAgentId : undefined;
      const newBranch = isBranchChanged ? branchValue.trim() : undefined;
      await restartAgentWorker(sessionId, agentWorker.id, continueConversation, agentId, newBranch);
      onOpenChange(false);
      if (newBranch && onBranchChange) {
        onBranchChange(newBranch);
      }
      if (onSessionRestart) {
        onSessionRestart();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to restart session'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setError(null);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart Session</AlertDialogTitle>
          <AlertDialogDescription>
            How would you like to restart this session?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400 shrink-0 w-14">Agent:</span>
            <AgentSelector
              value={selectedAgentId}
              onChange={setSelectedAgentId}
              className="flex-1"
            />
          </div>
          {isWorktreeSession && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400 shrink-0 w-14">Branch:</span>
              <input
                type="text"
                value={branchValue}
                onChange={(e) => setBranchValue(e.target.value)}
                className="input flex-1"
                placeholder="Branch name"
              />
            </div>
          )}
          {(isAgentChanged || isBranchChanged) && (
            <p className="text-xs text-yellow-400">
              {isAgentChanged && isBranchChanged
                ? 'Agent and branch will be changed. The terminal will be restarted.'
                : isAgentChanged
                  ? 'Agent will be switched. The terminal will be restarted with the new agent.'
                  : 'Branch will be renamed. The terminal will be restarted.'}
            </p>
          )}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>
            Cancel
          </AlertDialogCancel>
          <button
            onClick={() => handleRestart(false)}
            className="btn bg-slate-600 hover:bg-slate-500"
            disabled={isSubmitting}
          >
            New Session
          </button>
          <AlertDialogAction onClick={() => handleRestart(true)} disabled={isSubmitting}>
            {isSubmitting ? 'Restarting...' : 'Continue (-c)'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
