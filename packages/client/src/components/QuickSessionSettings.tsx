import { useState } from 'react';
import {
  QuickSessionSettingsMenu,
  InitialPromptDialog,
  EndSessionDialog,
  type QuickMenuAction,
} from './sessions';

interface QuickSessionSettingsProps {
  sessionId: string;
  sessionTitle?: string;
  initialPrompt?: string;
}

type DialogType = QuickMenuAction | null;

export function QuickSessionSettings({
  sessionId,
  sessionTitle,
  initialPrompt,
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
        onMenuAction={handleMenuAction}
      />

      <InitialPromptDialog
        open={activeDialog === 'view-initial-prompt'}
        onOpenChange={(open) => !open && closeDialog()}
        initialPrompt={initialPrompt}
      />

      <EndSessionDialog
        open={activeDialog === 'end-session'}
        onOpenChange={(open) => !open && closeDialog()}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
      />
    </>
  );
}
