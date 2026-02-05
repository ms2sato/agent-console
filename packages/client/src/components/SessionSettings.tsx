import { useState } from 'react';
import {
  SessionSettingsMenu,
  EditSessionDialog,
  RestartSessionDialog,
  DeleteWorktreeDialog,
  PauseSessionDialog,
  InitialPromptDialog,
  type MenuAction,
} from './sessions';
import type { Session, AgentActivityState } from '@agent-console/shared';

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
  onBranchChange: (newBranch: string) => void;
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
        onMenuAction={handleMenuAction}
      />

      <EditSessionDialog
        open={activeDialog === 'edit'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        currentBranch={currentBranch}
        currentTitle={currentTitle}
        onBranchChange={onBranchChange}
        onTitleChange={onTitleChange}
        onSessionRestart={onSessionRestart}
      />

      <RestartSessionDialog
        open={activeDialog === 'restart'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
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
