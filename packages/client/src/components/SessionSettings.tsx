import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  updateSessionMetadata,
  restartAgentWorker,
  deleteSession,
  deleteWorktree,
  openPath,
  getSession,
} from '../lib/api';
import {
  SettingsIcon,
  EditIcon,
  RefreshIcon,
  FolderIcon,
  CopyIcon,
  CloseIcon,
  TrashIcon,
} from './Icons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';

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

type DialogType = 'edit' | 'close' | 'restart' | 'delete-worktree' | 'confirm-restart' | null;

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
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [branchName, setBranchName] = useState(currentBranch);
  const [sessionTitle, setSessionTitle] = useState(currentTitle ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // Sync with current values when they change externally
  useEffect(() => {
    setBranchName(currentBranch);
  }, [currentBranch]);

  useEffect(() => {
    setSessionTitle(currentTitle ?? '');
  }, [currentTitle]);

  // Close menu on escape key or clicking outside
  useEffect(() => {
    if (!isMenuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-settings-menu]')) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const timeout = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timeout);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMenuOpen]);

  const handleCloseDialog = useCallback(() => {
    setActiveDialog(null);
    setBranchName(currentBranch);
    setSessionTitle(currentTitle ?? '');
    setError(null);
  }, [currentBranch, currentTitle]);

  // Check if branch has changed
  const branchChanged = branchName.trim() !== currentBranch;
  const titleChanged = sessionTitle.trim() !== (currentTitle ?? '');

  const handleEditSaveClick = () => {
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
      handleCloseDialog();
      return;
    }

    // If branch changed, show confirmation dialog
    if (branchChanged) {
      setActiveDialog('confirm-restart');
      return;
    }

    // Only title changed - save directly
    handleEditSubmit();
  };

  const handleEditSubmit = async () => {
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
      setActiveDialog(null);

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

  const handleRestart = async (continueConversation: boolean) => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Get the session to find the first agent worker
      const session = await getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      const agentWorker = session.workers.find(w => w.type === 'agent');
      if (!agentWorker) {
        throw new Error('No agent worker found');
      }
      await restartAgentWorker(sessionId, agentWorker.id, continueConversation);
      setActiveDialog(null);
      if (onSessionRestart) {
        onSessionRestart();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to restart session'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCloseSession = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      await deleteSession(sessionId);
      setActiveDialog(null);
      navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close session');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteWorktree = async (force: boolean = false) => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Server-side deleteWorktree also terminates any running sessions
      await deleteWorktree(repositoryId, worktreePath, force);
      setActiveDialog(null);
      navigate({ to: '/' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete worktree';
      // If deletion failed without force and error mentions untracked files, show retry option
      if (!force && message.includes('untracked')) {
        setError('Worktree has untracked files. Click "Force Delete" to proceed anyway.');
      } else {
        setError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenInFinder = async () => {
    setIsMenuOpen(false);
    try {
      await openPath(worktreePath);
    } catch (err) {
      console.error('Failed to open path:', err);
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(worktreePath);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
    setIsMenuOpen(false);
  };

  const openDialog = (type: DialogType) => {
    setIsMenuOpen(false);
    setActiveDialog(type);
  };

  return (
    <div className="relative" data-settings-menu>
      {/* Settings button */}
      <button
        onClick={() => setIsMenuOpen(!isMenuOpen)}
        className="text-gray-400 hover:text-white p-1.5 hover:bg-slate-700 rounded"
        title="Session settings"
      >
        <SettingsIcon />
      </button>

      {/* Dropdown menu */}
      {isMenuOpen && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50">
          <div className="py-1">
            <button
              onClick={() => openDialog('edit')}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <EditIcon />
              Edit Session
            </button>
            <button
              onClick={() => openDialog('restart')}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <RefreshIcon />
              Restart Session
            </button>
            <div className="border-t border-slate-700 my-1" />
            <button
              onClick={handleOpenInFinder}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <FolderIcon />
              Open in Finder
            </button>
            <button
              onClick={handleCopyPath}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <CopyIcon />
              {copySuccess ? 'Copied!' : 'Copy Path'}
            </button>
            <div className="border-t border-slate-700 my-1" />
            <button
              onClick={() => openDialog('close')}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <CloseIcon />
              Close Session
            </button>
            <button
              onClick={() => openDialog('delete-worktree')}
              className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-700 hover:text-red-300 flex items-center gap-2"
            >
              <TrashIcon />
              Delete Worktree
            </button>
          </div>
        </div>
      )}

      {/* Edit Session Dialog */}
      <Dialog open={activeDialog === 'edit'} onOpenChange={(open) => !open && handleCloseDialog()}>
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
                    handleEditSaveClick();
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
              onClick={handleCloseDialog}
              className="btn bg-slate-600 hover:bg-slate-500"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              onClick={handleEditSaveClick}
              className="btn btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Restart Dialog (shown when branch is changed) */}
      <AlertDialog open={activeDialog === 'confirm-restart'} onOpenChange={(open) => !open && setActiveDialog('edit')}>
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
            <AlertDialogAction onClick={handleEditSubmit} disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Restart & Save'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restart Session Dialog */}
      <AlertDialog open={activeDialog === 'restart'} onOpenChange={(open) => !open && handleCloseDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Session</AlertDialogTitle>
            <AlertDialogDescription>
              How would you like to restart this session?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <button
              onClick={() => handleRestart(false)}
              className="btn bg-slate-600 hover:bg-slate-500"
              disabled={isSubmitting}
            >
              New Session
            </button>
            <AlertDialogAction onClick={() => handleRestart(true)} disabled={isSubmitting}>
              {isSubmitting ? 'Restarting...' : 'Continue (-c)'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Close Session Dialog */}
      <AlertDialog open={activeDialog === 'close'} onOpenChange={(open) => !open && handleCloseDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close Session</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Are you sure you want to close this session?</p>
                <p className="text-xs text-gray-500">
                  This will stop the Claude process. The worktree will remain and
                  you can start a new session from it later.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseSession} disabled={isSubmitting}>
              {isSubmitting ? 'Closing...' : 'Close'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Worktree Dialog */}
      <AlertDialog open={activeDialog === 'delete-worktree'} onOpenChange={(open) => !open && handleCloseDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-400">Delete Worktree</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Are you sure you want to delete this worktree?</p>
                <p className="text-xs text-gray-500">
                  This will permanently delete the worktree directory and all its contents.
                </p>
                <p className="text-xs text-red-400">
                  This action cannot be undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            {error?.includes('untracked') ? (
              <button
                onClick={() => handleDeleteWorktree(true)}
                className="btn btn-danger"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Deleting...' : 'Force Delete'}
              </button>
            ) : (
              <button
                onClick={() => handleDeleteWorktree(false)}
                className="btn btn-danger"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Deleting...' : 'Delete Worktree'}
              </button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
