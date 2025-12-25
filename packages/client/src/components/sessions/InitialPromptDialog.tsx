import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';

export interface InitialPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt?: string;
}

export function InitialPromptDialog({
  open,
  onOpenChange,
  initialPrompt,
}: InitialPromptDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="left-16 right-16 -translate-x-0 w-auto max-w-none mx-0 p-4"
        aria-describedby={initialPrompt ? 'initial-prompt-content' : undefined}
      >
        <DialogHeader className="mb-2">
          <DialogTitle>Initial Prompt</DialogTitle>
          {!initialPrompt && (
            <DialogDescription>
              No initial prompt available
            </DialogDescription>
          )}
        </DialogHeader>
        {initialPrompt && (
          <pre
            id="initial-prompt-content"
            className="text-sm text-gray-300 bg-slate-900 rounded p-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono"
          >
            {initialPrompt}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
