import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  renameSessionBranch,
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

interface SessionSettingsProps {
  sessionId: string;
  repositoryId: string;
  currentBranch: string;
  worktreePath: string;
  onBranchChange: (newBranch: string) => void;
  onSessionRestart?: () => void;
}

type DialogType = 'rename' | 'close' | 'restart' | 'delete-worktree' | null;

export function SessionSettings({
  sessionId,
  repositoryId,
  currentBranch,
  worktreePath,
  onBranchChange,
  onSessionRestart,
}: SessionSettingsProps) {
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const [branchName, setBranchName] = useState(currentBranch);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Sync with current branch when it changes externally
  useEffect(() => {
    setBranchName(currentBranch);
  }, [currentBranch]);

  // Close menu on escape key or clicking outside
  useEffect(() => {
    if (!isMenuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

  // Close dialog on escape key or clicking outside
  useEffect(() => {
    if (!activeDialog) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseDialog();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        handleCloseDialog();
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
  }, [activeDialog]);

  const handleCloseDialog = useCallback(() => {
    setActiveDialog(null);
    setBranchName(currentBranch);
    setError(null);
  }, [currentBranch]);

  const handleRenameSubmit = async () => {
    const trimmedBranch = branchName.trim();

    if (!trimmedBranch) {
      setError('Branch name is required');
      return;
    }

    if (trimmedBranch === currentBranch) {
      handleCloseDialog();
      return;
    }

    // Validate branch name (basic git branch name rules)
    if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
      setError(
        'Invalid branch name. Use alphanumeric, dots, underscores, slashes, or hyphens.'
      );
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await renameSessionBranch(sessionId, trimmedBranch);
      onBranchChange(result.branch);
      setActiveDialog(null);

      // Restart session with -c flag to pick up new branch name while keeping conversation
      if (onSessionRestart) {
        // Get the session to find the first agent worker
        const session = await getSession(sessionId);
        if (session) {
          const agentWorker = session.workers.find(w => w.type === 'agent');
          if (agentWorker) {
            await restartAgentWorker(sessionId, agentWorker.id, true);
          }
        }
        onSessionRestart();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename branch');
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
    <div className="relative" ref={menuRef}>
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
              onClick={() => openDialog('rename')}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <EditIcon />
              Rename Branch
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

      {/* Rename Branch Dialog */}
      {activeDialog === 'rename' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="fixed inset-0 bg-black/50" />
          <div
            ref={dialogRef}
            className="relative bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
          >
            <h2 className="text-lg font-medium mb-4">Rename Branch</h2>
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-2">
                Branch Name
              </label>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSubmitting) {
                    handleRenameSubmit();
                  }
                }}
                className="input w-full"
                placeholder="Enter branch name"
                autoFocus
              />
              {error && <p className="text-sm text-red-400 mt-1">{error}</p>}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDialog}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleRenameSubmit}
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restart Session Dialog */}
      {activeDialog === 'restart' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="fixed inset-0 bg-black/50" />
          <div
            ref={dialogRef}
            className="relative bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
          >
            <h2 className="text-lg font-medium mb-4">Restart Session</h2>
            <p className="text-gray-400 mb-6">
              How would you like to restart this session?
            </p>
            {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDialog}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={() => handleRestart(false)}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                New Session
              </button>
              <button
                onClick={() => handleRestart(true)}
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Restarting...' : 'Continue (-c)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Session Dialog */}
      {activeDialog === 'close' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="fixed inset-0 bg-black/50" />
          <div
            ref={dialogRef}
            className="relative bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
          >
            <h2 className="text-lg font-medium mb-4">Close Session</h2>
            <p className="text-gray-400 mb-2">
              Are you sure you want to close this session?
            </p>
            <p className="text-sm text-gray-500 mb-6">
              This will stop the Claude process. The worktree will remain and
              you can start a new session from it later.
            </p>
            {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDialog}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleCloseSession}
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Closing...' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Worktree Dialog */}
      {activeDialog === 'delete-worktree' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          <div className="fixed inset-0 bg-black/50" />
          <div
            ref={dialogRef}
            className="relative bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
          >
            <h2 className="text-lg font-medium mb-4 text-red-400">Delete Worktree</h2>
            <p className="text-gray-400 mb-2">
              Are you sure you want to delete this worktree?
            </p>
            <p className="text-sm text-gray-500 mb-2">
              This will permanently delete the worktree directory and all its contents.
            </p>
            <p className="text-sm text-red-400 mb-6">
              This action cannot be undone.
            </p>
            {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDialog}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                Cancel
              </button>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
