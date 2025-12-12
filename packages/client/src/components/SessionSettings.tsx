import { useState } from 'react';
import {
  SessionSettingsMenu,
  EditSessionDialog,
  RestartSessionDialog,
  CloseSessionDialog,
  DeleteWorktreeDialog,
  type MenuAction,
} from './session-settings';

interface SessionSettingsProps {
  sessionId: string;
  repositoryId: string;
  currentBranch: string;
  currentTitle?: string;
  worktreePath: string;
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
  worktreePath,
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
        worktreePath={worktreePath}
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

      <CloseSessionDialog
        open={activeDialog === 'close'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
      />

      <DeleteWorktreeDialog
        open={activeDialog === 'delete-worktree'}
        onOpenChange={(open) => !open && closeDialog()}
        repositoryId={repositoryId}
        worktreePath={worktreePath}
      />
    </>
  );
}
