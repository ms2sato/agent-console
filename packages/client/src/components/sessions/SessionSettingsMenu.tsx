import { useState, useEffect } from 'react';
import {
  SettingsIcon,
  EditIcon,
  RefreshIcon,
  FolderIcon,
  CopyIcon,
  TrashIcon,
  DocumentIcon,
} from '../Icons';
import { openPath } from '../../lib/api';

export type MenuAction = 'edit' | 'restart' | 'delete-worktree' | 'view-initial-prompt';

export interface SessionSettingsMenuProps {
  worktreePath: string;
  initialPrompt?: string;
  onMenuAction: (action: MenuAction) => void;
}

export function SessionSettingsMenu({
  worktreePath,
  initialPrompt,
  onMenuAction,
}: SessionSettingsMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

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

  const handleMenuAction = (action: MenuAction) => {
    setIsMenuOpen(false);
    onMenuAction(action);
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
              onClick={() => handleMenuAction('edit')}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
            >
              <EditIcon />
              Edit Session
            </button>
            {initialPrompt && (
              <button
                onClick={() => handleMenuAction('view-initial-prompt')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
              >
                <DocumentIcon />
                View Initial Prompt
              </button>
            )}
            <button
              onClick={() => handleMenuAction('restart')}
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
              onClick={() => handleMenuAction('delete-worktree')}
              className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-700 hover:text-red-300 flex items-center gap-2"
            >
              <TrashIcon />
              Delete Worktree
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
