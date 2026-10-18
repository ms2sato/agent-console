import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
} from '../ui/alert-dialog';
import type { HookCommandResult } from '@agent-console/shared';

export interface HookCommandFailureDialogProps {
  /** The failed hook result to show; the dialog is open while this is non-null. */
  result: HookCommandResult | null;
  title: string;
  /** Sentence explaining what DID succeed before the hook command failed. */
  intro: string;
  /** Optional muted guidance shown under the command output. */
  hint?: string;
  onClose: () => void;
}

/**
 * Shows the error text and output of a repository hook command (setup, pause,
 * resume) that failed after the primary operation had already succeeded.
 */
export function HookCommandFailureDialog({ result, title, intro, hint, onClose }: HookCommandFailureDialogProps) {
  return (
    <AlertDialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
            <p>{intro}</p>
            <div className="bg-slate-900 rounded p-3 text-sm max-h-60 overflow-auto">
              {result?.error && (
                <div className="text-red-400 font-mono whitespace-pre-wrap">
                  {result.error}
                </div>
              )}
              {result?.output && (
                <div className="text-gray-400 font-mono whitespace-pre-wrap mt-2 border-t border-slate-700 pt-2">
                  <span className="text-gray-500 text-xs">Output:</span>
                  <pre className="mt-1">{result.output}</pre>
                </div>
              )}
            </div>
            {hint && <p className="text-xs text-gray-500">{hint}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* The action closes the dialog, which reports through onOpenChange: onClose fires exactly once. */}
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
