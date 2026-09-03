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
  /**
   * The session's PRIMARY worker's current agent/embedded-agent identity --
   * the first worker of type 'agent' or 'embedded-agent' in the session.
   * `undefined` while the parent's `session` hasn't loaded yet (don't
   * disable / assume terminal-like defaults while unknown -- mirrors the
   * pre-#1592 `hasAgentWorker=true` default's "don't disable while unknown"
   * semantics). Since #1592 every session has SOMETHING restartable through
   * this dialog (an embedded-primary session's primary worker is no longer
   * a disabled-with-notice special case), there is no longer a boolean
   * "restart not supported" state at all.
   */
  currentSelection?: AgentSelection;
  currentBranch?: string;
  isWorktreeSession?: boolean;
  onSessionRestart?: () => void;
  onBranchChange?: (newBranch: string) => void;
}

// Cross-type restart (R6(a), #1171) exact wording, ruled by the Architect --
// do not paraphrase.
const EMBEDDED_SWITCH_NOTICE =
  'Agent will be switched to an embedded agent. The terminal will be replaced with a chat; its transcript is not carried over.';

// Cross-type restart from an embedded-primary session (#1592) exact wording,
// ruled by the Architect -- do not paraphrase.
const EMBEDDED_SAME_DEFINITION_NOTICE = 'The conversation is kept.';
const EMBEDDED_DIFFERENT_DEFINITION_NOTICE = 'The conversation is not carried over to the new agent.';
const EMBEDDED_TO_TERMINAL_NOTICE =
  'The chat is replaced by a terminal; the conversation is not carried over.';

type LocalSelection =
  | { kind: 'terminal'; agentId: string | undefined }
  | { kind: 'embedded'; embeddedAgentId: string | undefined };

function toLocalSelection(selection: AgentSelection | undefined): LocalSelection {
  if (selection?.kind === 'embedded') {
    return { kind: 'embedded', embeddedAgentId: selection.embeddedAgentId };
  }
  return { kind: 'terminal', agentId: selection?.kind === 'terminal' ? selection.agentId : undefined };
}

export function RestartSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentSelection,
  currentBranch,
  isWorktreeSession,
  onSessionRestart,
  onBranchChange,
}: RestartSessionDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<LocalSelection>(toLocalSelection(currentSelection));
  const [branchValue, setBranchValue] = useState(currentBranch ?? '');

  const isCurrentEmbedded = currentSelection?.kind === 'embedded';
  const currentAgentId = currentSelection?.kind === 'terminal' ? currentSelection.agentId : undefined;
  const currentEmbeddedAgentId = currentSelection?.kind === 'embedded' ? currentSelection.embeddedAgentId : undefined;

  const resolvedAgentId = useResolvedAgentId(
    selection.kind === 'terminal' ? selection.agentId : undefined,
    currentAgentId
  );
  const resolvedEmbeddedAgentId = useResolvedEmbeddedAgentId(
    selection.kind === 'embedded' ? selection.embeddedAgentId : undefined
  );

  // Reset selection and branch when dialog opens. Depends on the derived
  // primitives (kind + id), not the `currentSelection` object itself --
  // SessionSettings.tsx derives that object inline on every render, so a
  // reference-identity dependency would re-run (and clobber the user's
  // in-progress selection) on every unrelated parent re-render while the
  // dialog is open, not just when it actually opens.
  useEffect(() => {
    if (open) {
      setSelection(toLocalSelection(currentSelection));
      setBranchValue(currentBranch ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentSelection?.kind, currentAgentId, currentEmbeddedAgentId, currentBranch]);

  const isEmbeddedSelection = selection.kind === 'embedded';
  // Only meaningful when the CURRENT worker is itself terminal (the
  // agent->agent / agent->embedded cases below) -- an embedded current
  // worker has its own same/different-definition comparison instead.
  const isAgentChanged = selection.kind === 'terminal' && resolvedAgentId !== currentAgentId;
  const trimmedBranch = branchValue.trim();
  const isBranchEmpty = isWorktreeSession === true && trimmedBranch === '';
  const isBranchChanged = isWorktreeSession === true && trimmedBranch !== '' && trimmedBranch !== (currentBranch ?? '');

  // The three embedded-primary-session cases (R6(a-c), #1592). Mutually
  // exclusive with each other and with the agent->{agent,embedded} cases
  // above, gated on isCurrentEmbedded.
  const isEmbeddedToTerminal = isCurrentEmbedded && selection.kind === 'terminal';
  const isSameEmbeddedDefinition =
    isCurrentEmbedded && selection.kind === 'embedded' && resolvedEmbeddedAgentId === currentEmbeddedAgentId;
  const isDifferentEmbeddedDefinition =
    isCurrentEmbedded && selection.kind === 'embedded' && resolvedEmbeddedAgentId !== currentEmbeddedAgentId;

  const handleRestart = async (continueConversation: boolean) => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Get the session to find the primary worker being restarted.
      const session = await getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      const worker = session.workers.find((w) => w.type === 'agent' || w.type === 'embedded-agent');
      if (!worker) {
        throw new Error('No agent worker found');
      }
      const newBranch = isBranchChanged ? trimmedBranch : undefined;

      if (isEmbeddedSelection) {
        if (!resolvedEmbeddedAgentId) {
          throw new Error('No embedded agent selected');
        }
        // Covers both the same-definition restart (case c) and a
        // definition switch (case b) -- the server dispatches internally
        // based on whether the existing worker is already that same
        // embeddedAgentId (worker-lifecycle-manager.ts's
        // restartAgentWorkerAsEmbedded).
        await restartWorkerAsEmbeddedAgent(sessionId, worker.id, resolvedEmbeddedAgentId, newBranch);
      } else {
        // Terminal target. When the CURRENT worker is embedded, the
        // server's R2 check REQUIRES agentId -- there is no "current
        // terminal agent" to fall back to, since there is no current PTY
        // agent at all. When the current worker is itself terminal,
        // preserve the existing only-pass-when-changed semantics (agentId
        // omitted means "keep the existing agent").
        const agentId = isCurrentEmbedded ? resolvedAgentId : (isAgentChanged ? resolvedAgentId : undefined);
        await restartAgentWorker(sessionId, worker.id, continueConversation, agentId, newBranch);
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
    (isEmbeddedSelection && !resolvedEmbeddedAgentId);

  // Continue (-c) is NEVER offered when the CURRENT worker is embedded --
  // the server's R2 runtime check rejects `continueConversation: true`
  // against an embedded existing worker (there is no PTY conversation to
  // continue), so the dialog must not offer what the wire refuses.
  const showContinue = !isCurrentEmbedded && !isEmbeddedSelection;

  let primaryButtonLabel = 'New Session';
  if (isEmbeddedToTerminal) {
    primaryButtonLabel = 'Switch to terminal';
  } else if (isDifferentEmbeddedDefinition) {
    primaryButtonLabel = 'Switch';
  } else if (isSameEmbeddedDefinition) {
    primaryButtonLabel = 'Restart';
  }

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
          {isBranchEmpty && (
            <p className="text-xs text-red-400">Branch name cannot be empty.</p>
          )}
          {isEmbeddedToTerminal && (
            <p className="text-xs text-yellow-400">{EMBEDDED_TO_TERMINAL_NOTICE}</p>
          )}
          {isSameEmbeddedDefinition && (
            <p className="text-xs text-yellow-400">{EMBEDDED_SAME_DEFINITION_NOTICE}</p>
          )}
          {isDifferentEmbeddedDefinition && (
            <p className="text-xs text-yellow-400">{EMBEDDED_DIFFERENT_DEFINITION_NOTICE}</p>
          )}
          {!isCurrentEmbedded && isEmbeddedSelection && (
            <p className="text-xs text-yellow-400">{EMBEDDED_SWITCH_NOTICE}</p>
          )}
          {!isCurrentEmbedded && !isEmbeddedSelection && isAgentChanged && isBranchChanged && (
            <p className="text-xs text-yellow-400">
              Agent and branch will be changed. The terminal will be restarted.
            </p>
          )}
          {!isCurrentEmbedded && !isEmbeddedSelection && isAgentChanged && !isBranchChanged && (
            <p className="text-xs text-yellow-400">
              Agent will be switched. The terminal will be restarted with the new agent.
            </p>
          )}
          {!isCurrentEmbedded && !isEmbeddedSelection && !isAgentChanged && isBranchChanged && (
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
            {primaryButtonLabel}
          </button>
          {showContinue && (
            <AlertDialogAction onClick={() => handleRestart(true)} disabled={submitDisabled}>
              {isSubmitting ? 'Restarting...' : 'Continue (-c)'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
