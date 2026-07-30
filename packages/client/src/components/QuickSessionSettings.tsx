import { useState } from 'react';
import {
  QuickSessionSettingsMenu,
  InitialPromptDialog,
  EndSessionDialog,
  type QuickMenuAction,
} from './sessions';
import type { Session, AgentActivityState } from '@agent-console/shared';

interface QuickSessionSettingsProps {
  sessionId: string;
  sessionTitle?: string;
  initialPrompt?: string;
  session?: Session;
  /** Activity states for workers in this session: { workerId: state } */
  workerActivityStates?: Record<string, AgentActivityState>;
  /** Disables the "Stop Session" menu entry, e.g. while a stop task is already in flight */
  stopDisabled?: boolean;
}

type DialogType = QuickMenuAction | null;

export function QuickSessionSettings({
  sessionId,
  sessionTitle,
  initialPrompt,
  session,
  workerActivityStates,
  stopDisabled,
}: QuickSessionSettingsProps) {
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);

  const handleMenuAction = (action: QuickMenuAction) => {
    setActiveDialog(action);
  };

  const closeDialog = () => {
    setActiveDialog(null);
  };

  return (
    <>
      <QuickSessionSettingsMenu
        initialPrompt={initialPrompt}
        stopDisabled={stopDisabled}
        onMenuAction={handleMenuAction}
      />

      <InitialPromptDialog
        open={activeDialog === 'view-initial-prompt'}
        onOpenChange={(open) => !open && closeDialog()}
        initialPrompt={initialPrompt}
      />

      <EndSessionDialog
        open={activeDialog === 'stop-session'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        session={session}
        workerActivityStates={workerActivityStates}
      />
    </>
  );
}
