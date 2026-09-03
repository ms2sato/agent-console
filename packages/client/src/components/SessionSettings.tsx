import { useState } from 'react';
import { SessionSettingsMenu, type MenuAction } from './sessions/SessionSettingsMenu';
import { EditSessionDialog } from './sessions/EditSessionDialog';
import { RestartSessionDialog } from './sessions/RestartSessionDialog';
import { DeleteWorktreeDialog } from './sessions/DeleteWorktreeDialog';
import { PauseSessionDialog } from './sessions/PauseSessionDialog';
import { InitialPromptDialog } from './sessions/InitialPromptDialog';
import type { AgentSelection } from './AgentSelector';
import type { Session, AgentActivityState } from '@agent-console/shared';

/**
 * Derive the primary-worker selection for RestartSessionDialog: the first
 * worker of type 'agent' or 'embedded-agent' in the session. `undefined`
 * while `session` hasn't loaded yet -- RestartSessionDialog treats that the
 * same way it always has (don't disable / assume terminal-like defaults
 * while unknown).
 */
function derivePrimarySelection(session: Session | undefined): AgentSelection | undefined {
  if (!session) return undefined;
  for (const worker of session.workers) {
    if (worker.type === 'agent') return { kind: 'terminal', agentId: worker.agentId };
    if (worker.type === 'embedded-agent') return { kind: 'embedded', embeddedAgentId: worker.embeddedAgentId };
  }
  return undefined;
}

interface SessionSettingsProps {
  sessionId: string;
  repositoryId: string;
  currentBranch: string;
  currentTitle?: string;
  initialPrompt?: string;
  worktreePath: string;
  isMainWorktree: boolean;
  session?: Session;
  /** Activity states for workers in this session: { workerId: state } */
  workerActivityStates?: Record<string, AgentActivityState>;
  /** Disables the "Pause" menu entry, e.g. while a stop/pause task is already in flight */
  pauseDisabled?: boolean;
  onBranchChange?: (newBranch: string) => void;
  onTitleChange?: (newTitle: string) => void;
  onSessionRestart?: () => void;
}

type DialogType = MenuAction | null;

export function SessionSettings({
  sessionId,
  repositoryId,
  currentBranch,
  currentTitle,
  initialPrompt,
  worktreePath,
  isMainWorktree,
  session,
  workerActivityStates,
  pauseDisabled,
  onBranchChange,
  onTitleChange,
  onSessionRestart,
}: SessionSettingsProps) {
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);

  const handleMenuAction = (action: MenuAction) => {
    setActiveDialog(action);
  };

  const closeDialog = () => {
    setActiveDialog(null);
  };

  return (
    <>
      <SessionSettingsMenu
        sessionId={sessionId}
        worktreePath={worktreePath}
        initialPrompt={initialPrompt}
        isMainWorktree={isMainWorktree}
        pauseDisabled={pauseDisabled}
        onMenuAction={handleMenuAction}
      />

      <EditSessionDialog
        open={activeDialog === 'edit'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        currentTitle={currentTitle}
        onTitleChange={onTitleChange}
      />

      <RestartSessionDialog
        open={activeDialog === 'restart'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        currentSelection={derivePrimarySelection(session)}
        currentBranch={currentBranch}
        isWorktreeSession={true}
        onBranchChange={onBranchChange}
        onSessionRestart={onSessionRestart}
      />

      <DeleteWorktreeDialog
        open={activeDialog === 'delete-worktree'}
        onOpenChange={(open) => !open && closeDialog()}
        repositoryId={repositoryId}
        worktreePath={worktreePath}
        sessionId={sessionId}
        sessionTitle={currentTitle}
      />

      <PauseSessionDialog
        open={activeDialog === 'pause'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        sessionTitle={currentTitle}
        session={session}
        workerActivityStates={workerActivityStates}
      />

      <InitialPromptDialog
        open={activeDialog === 'view-initial-prompt'}
        onOpenChange={(open) => !open && closeDialog()}
        initialPrompt={initialPrompt}
      />
    </>
  );
}
