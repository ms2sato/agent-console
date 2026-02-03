import { useState, useEffect } from 'react';
import {
  SettingsIcon,
  DocumentIcon,
  StopIcon,
} from '../Icons';

export type QuickMenuAction = 'view-initial-prompt' | 'stop-session';

export interface QuickSessionSettingsMenuProps {
  initialPrompt?: string;
  onMenuAction: (action: QuickMenuAction) => void;
}

export function QuickSessionSettingsMenu({
  initialPrompt,
  onMenuAction,
}: QuickSessionSettingsMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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

  const handleMenuAction = (action: QuickMenuAction) => {
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
            {initialPrompt && (
              <button
                onClick={() => handleMenuAction('view-initial-prompt')}
                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
              >
                <DocumentIcon />
                View Initial Prompt
              </button>
            )}
            {initialPrompt && (
              <div className="border-t border-slate-700 my-1" />
            )}
            <button
              onClick={() => handleMenuAction('stop-session')}
              className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-700 hover:text-red-300 flex items-center gap-2"
            >
              <StopIcon />
              Stop Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
