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
import { restartAgentWorker, restartWorkerAsEmbeddedAgent, getSession } from '../../lib/api';
import { UnifiedAgentSelector, useResolvedEmbeddedAgentId, type AgentSelection } from '../AgentSelector';
import { useResolvedAgentId } from '../../hooks/useAgents';

export interface RestartSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentAgentId?: string;
  /**
   * Whether the session currently has a PTY `agent` worker to restart.
   * `undefined`/omitted (parent's `session` hasn't loaded yet) is treated as
   * `true` (don't disable while unknown). `false` means the session's
   * primary worker is already `embedded-agent` (no PTY at all) -- restarting
   * THAT worker isn't supported yet (#1592); see R6(c).
   */
  hasAgentWorker?: boolean;
  currentBranch?: string;
  isWorktreeSession?: boolean;
  onSessionRestart?: () => void;
  onBranchChange?: (newBranch: string) => void;
}

// Cross-type restart (R6(c)): the primary worker of an embedded-primary
// session (no PTY `agent` worker at all) cannot be restarted through this
// dialog yet.
const NO_PTY_WORKER_NOTICE =
  "Restarting an embedded-agent session's primary worker isn't supported yet — tracked in #1592.";

// Cross-type restart (R6(a)) exact wording, ruled by the Architect -- do not
// paraphrase.
const EMBEDDED_SWITCH_NOTICE =
  'Agent will be switched to an embedded agent. The terminal will be replaced with a chat; its transcript is not carried over.';

type LocalSelection =
  | { kind: 'terminal'; agentId: string | undefined }
  | { kind: 'embedded'; embeddedAgentId: string | undefined };

export function RestartSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentAgentId,
  hasAgentWorker = true,
  currentBranch,
  isWorktreeSession,
  onSessionRestart,
  onBranchChange,
}: RestartSessionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<LocalSelection>({ kind: 'terminal', agentId: currentAgentId });
  const [branchValue, setBranchValue] = useState(currentBranch ?? '');
  const resolvedAgentId = useResolvedAgentId(
    selection.kind === 'terminal' ? selection.agentId : undefined,
    currentAgentId
  );
  const resolvedEmbeddedAgentId = useResolvedEmbeddedAgentId(
    selection.kind === 'embedded' ? selection.embeddedAgentId : undefined
  );

  // Reset selection and branch when dialog opens
  useEffect(() => {
    if (open) {
      setSelection({ kind: 'terminal', agentId: currentAgentId });
      setBranchValue(currentBranch ?? '');
    }
  }, [open, currentAgentId, currentBranch]);

  const isEmbeddedSelection = selection.kind === 'embedded';
  const isAgentChanged = selection.kind === 'terminal' && resolvedAgentId !== currentAgentId;
  const trimmedBranch = branchValue.trim();
  const isBranchEmpty = isWorktreeSession === true && trimmedBranch === '';
  const isBranchChanged = isWorktreeSession === true && trimmedBranch !== '' && trimmedBranch !== (currentBranch ?? '');

  const handleRestart = async (continueConversation: boolean) => {
    if (!hasAgentWorker) return; // submit is disabled for this case; defensive no-op
    setIsSubmitting(true);
    setError(null);

    try {
      // Get the session to find the agent worker being restarted.
      const session = await getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      const agentWorker = session.workers.find(w => w.type === 'agent');
      if (!agentWorker) {
        throw new Error('No agent worker found');
      }
      const newBranch = isBranchChanged ? trimmedBranch : undefined;

      if (isEmbeddedSelection) {
        if (!resolvedEmbeddedAgentId) {
          throw new Error('No embedded agent selected');
        }
        await restartWorkerAsEmbeddedAgent(sessionId, agentWorker.id, resolvedEmbeddedAgentId, newBranch);
      } else {
        const agentId = isAgentChanged ? resolvedAgentId : undefined;
        await restartAgentWorker(sessionId, agentWorker.id, continueConversation, agentId, newBranch);
      }

      onOpenChange(false);
      if (newBranch) {
        onBranchChange?.(newBranch);
      }
      onSessionRestart?.();
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

  const handleAgentSelectionChange = (newSelection: AgentSelection) => {
    if (newSelection.kind === 'terminal') {
      setSelection({ kind: 'terminal', agentId: newSelection.agentId });
    } else {
      setSelection({ kind: 'embedded', embeddedAgentId: newSelection.embeddedAgentId });
    }
  };

  const submitDisabled =
    isSubmitting ||
    isBranchEmpty ||
    !hasAgentWorker ||
    (isEmbeddedSelection && !resolvedEmbeddedAgentId);

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
            <UnifiedAgentSelector
              agentId={selection.kind === 'terminal' ? resolvedAgentId : undefined}
              embeddedAgentId={selection.kind === 'embedded' ? resolvedEmbeddedAgentId : undefined}
              onChange={handleAgentSelectionChange}
              className="flex-1"
              priorityAgentId={currentAgentId}
              disabled={!hasAgentWorker}
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
                disabled={!hasAgentWorker}
              />
            </div>
          )}
          {isBranchEmpty && (
            <p className="text-xs text-red-400">Branch name cannot be empty.</p>
          )}
          {!hasAgentWorker && (
            <p className="text-xs text-yellow-400">{NO_PTY_WORKER_NOTICE}</p>
          )}
          {hasAgentWorker && isEmbeddedSelection && (
            <p className="text-xs text-yellow-400">{EMBEDDED_SWITCH_NOTICE}</p>
          )}
          {hasAgentWorker && !isEmbeddedSelection && isAgentChanged && isBranchChanged && (
            <p className="text-xs text-yellow-400">
              Agent and branch will be changed. The terminal will be restarted.
            </p>
          )}
          {hasAgentWorker && !isEmbeddedSelection && isAgentChanged && !isBranchChanged && (
            <p className="text-xs text-yellow-400">
              Agent will be switched. The terminal will be restarted with the new agent.
            </p>
          )}
          {hasAgentWorker && !isEmbeddedSelection && !isAgentChanged && isBranchChanged && (
            <p className="text-xs text-yellow-400">
              Branch will be renamed. The terminal will be restarted.
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
            disabled={submitDisabled}
          >
            New Session
          </button>
          {!isEmbeddedSelection && (
            <AlertDialogAction onClick={() => handleRestart(true)} disabled={submitDisabled}>
              {isSubmitting ? 'Restarting...' : 'Continue (-c)'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
