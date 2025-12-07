import { useState, useEffect, useCallback, useRef } from 'react';
import { renameSessionBranch, restartSession } from '../lib/api';

interface SessionSettingsProps {
  sessionId: string;
  currentBranch: string;
  onBranchChange: (newBranch: string) => void;
  onSessionRestart?: () => void;
}

export function SessionSettings({
  sessionId,
  currentBranch,
  onBranchChange,
  onSessionRestart,
}: SessionSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [branchName, setBranchName] = useState(currentBranch);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Sync with current branch when it changes externally
  useEffect(() => {
    setBranchName(currentBranch);
  }, [currentBranch]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };

    // Delay to avoid closing immediately from the button click
    const timeout = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setBranchName(currentBranch);
    setError(null);
  }, [currentBranch]);

  const handleSubmit = async () => {
    const trimmedBranch = branchName.trim();

    if (!trimmedBranch) {
      setError('Branch name is required');
      return;
    }

    if (trimmedBranch === currentBranch) {
      handleClose();
      return;
    }

    // Validate branch name (basic git branch name rules)
    if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch)) {
      setError('Invalid branch name. Use alphanumeric, dots, underscores, slashes, or hyphens.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await renameSessionBranch(sessionId, trimmedBranch);
      onBranchChange(result.branch);
      setIsOpen(false);

      // Restart session with -c flag to pick up new branch name while keeping conversation
      if (onSessionRestart) {
        await restartSession(sessionId, true); // continueConversation=true
        onSessionRestart();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename branch');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative">
      {/* Settings button */}
      <button
        onClick={() => setIsOpen(true)}
        className="text-gray-400 hover:text-white p-1.5 hover:bg-slate-700 rounded"
        title="Session settings"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      {/* Modal dialog */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/50" />

          {/* Dialog */}
          <div
            ref={dialogRef}
            className="relative bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
          >
            <h2 className="text-lg font-medium mb-4">Session Settings</h2>

            {/* Branch name field */}
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
                    handleSubmit();
                  }
                }}
                className="input w-full"
                placeholder="Enter branch name"
                autoFocus
              />
              {error && (
                <p className="text-sm text-red-400 mt-1">{error}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleClose}
                className="btn bg-slate-600 hover:bg-slate-500"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
