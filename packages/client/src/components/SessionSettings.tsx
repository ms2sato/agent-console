import { useState } from 'react';
import { SessionSettingsMenu, type MenuAction } from './sessions/SessionSettingsMenu';
import { EditSessionDialog } from './sessions/EditSessionDialog';
import { RestartSessionDialog } from './sessions/RestartSessionDialog';
import { DeleteWorktreeDialog } from './sessions/DeleteWorktreeDialog';
import { PauseSessionDialog } from './sessions/PauseSessionDialog';
import { InitialPromptDialog } from './sessions/InitialPromptDialog';
import type { Session, AgentActivityState, AgentWorker } from '@agent-console/shared';

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
        currentAgentId={(session?.workers.find((w): w is AgentWorker => w.type === 'agent'))?.agentId}
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
