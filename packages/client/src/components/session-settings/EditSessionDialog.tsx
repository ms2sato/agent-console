import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
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
import { updateSessionMetadata } from '../../lib/api';

export interface EditSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentBranch: string;
  currentTitle?: string;
  onBranchChange: (newBranch: string) => void;
  onTitleChange?: (newTitle: string) => void;
  onSessionRestart?: () => void;
}

type DialogMode = 'edit' | 'confirm-restart';

export function EditSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentBranch,
  currentTitle,
  onBranchChange,
  onTitleChange,
  onSessionRestart,
}: EditSessionDialogProps) {
  const [mode, setMode] = useState<DialogMode>('edit');
  const [branchName, setBranchName] = useState(currentBranch);
  const [sessionTitle, setSessionTitle] = useState(currentTitle ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync with current values when they change externally
  useEffect(() => {
    setBranchName(currentBranch);
  }, [currentBranch]);

  useEffect(() => {
    setSessionTitle(currentTitle ?? '');
  }, [currentTitle]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setMode('edit');
      setBranchName(currentBranch);
      setSessionTitle(currentTitle ?? '');
      setError(null);
    }
  }, [open, currentBranch, currentTitle]);

  const branchChanged = branchName.trim() !== currentBranch;
  const titleChanged = sessionTitle.trim() !== (currentTitle ?? '');

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleSaveClick = () => {
    const trimmedBranch = branchName.trim();

    if (!trimmedBranch) {
      setError('Branch name is required');
      return;
    }

    // Validate branch name (basic git branch name rules)
    if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
      setError(
        'Invalid branch name. Use alphanumeric, dots, underscores, slashes, or hyphens.'
      );
      return;
    }

    // If no changes, just close
    if (!branchChanged && !titleChanged) {
      handleClose();
      return;
    }

    // If branch changed, show confirmation dialog
    if (branchChanged) {
      setMode('confirm-restart');
      return;
    }

    // Only title changed - save directly
    handleSubmit();
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const updates: { title?: string; branch?: string } = {};

      if (titleChanged) {
        updates.title = sessionTitle.trim();
      }
      if (branchChanged) {
        updates.branch = branchName.trim();
      }

      const result = await updateSessionMetadata(sessionId, updates);

      if (result.title !== undefined && onTitleChange) {
        onTitleChange(result.title);
      }
      if (result.branch) {
        onBranchChange(result.branch);
      }
      onOpenChange(false);

      // Notify parent that session was restarted (server does this automatically when branch changes)
      if (branchChanged && onSessionRestart) {
        onSessionRestart();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update session');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (mode === 'confirm-restart') {
    return (
      <AlertDialog open={open} onOpenChange={() => setMode('edit')}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Required</AlertDialogTitle>
            <AlertDialogDescription>
              Branch name change requires restarting the agent. Do you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Restart & Save'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Session</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Title
            </label>
            <input
              type="text"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              className="input w-full"
              placeholder="Session title (optional)"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Branch Name
            </label>
            <input
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSubmitting) {
                  handleSaveClick();
                }
              }}
              className="input w-full"
              placeholder="Enter branch name"
            />
            {error && <p className="text-sm text-red-400 mt-1">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <button
            onClick={handleClose}
            className="btn bg-slate-600 hover:bg-slate-500"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            onClick={handleSaveClick}
            className="btn btn-primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
