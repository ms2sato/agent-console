import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionBranches } from '../../lib/api';
import { EditIcon } from '../Icons';

interface BaseCommitSelectorProps {
  sessionId: string;
  currentBaseCommit: string | null;
  onBaseCommitChange: (ref: string) => void;
  disabled?: boolean;
}

export function BaseCommitSelector({
  sessionId,
  currentBaseCommit,
  onBaseCommitChange,
  disabled = false,
}: BaseCommitSelectorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch branches when editing starts
  const { data: branchesData } = useQuery({
    queryKey: ['sessionBranches', sessionId],
    queryFn: () => fetchSessionBranches(sessionId),
    enabled: isEditing,
    staleTime: 30000, // Cache for 30 seconds
  });

  // Format display value - show commit hash clearly
  const shortCommit = currentBaseCommit ? currentBaseCommit.substring(0, 7) : null;

  // Filter branches based on input
  const filteredBranches = branchesData
    ? [
        ...branchesData.local.filter(b => b.toLowerCase().includes(inputValue.toLowerCase())),
        ...branchesData.remote
          .filter(b => b.toLowerCase().includes(inputValue.toLowerCase()))
          .filter(b => !branchesData.local.includes(b.replace(/^origin\//, ''))),
      ].slice(0, 10)
    : [];

  const handleStartEdit = useCallback(() => {
    if (disabled) return;
    setIsEditing(true);
    setInputValue('');
    setShowDropdown(true);
  }, [disabled]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setShowDropdown(false);
    setInputValue('');
  }, []);

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      onBaseCommitChange(trimmed);
    }
    setIsEditing(false);
    setShowDropdown(false);
    setInputValue('');
  }, [onBaseCommitChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(inputValue);
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  }, [inputValue, handleSubmit, handleCancel]);

  const handleSelectBranch = useCallback((branch: string) => {
    handleSubmit(branch);
  }, [handleSubmit]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        handleCancel();
      }
    };

    if (isEditing) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isEditing, handleCancel]);

  if (isEditing) {
    return (
      <div className="relative inline-block">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setShowDropdown(true);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowDropdown(true)}
            placeholder="branch or commit..."
            className="px-2 py-0.5 text-sm bg-slate-700 border border-slate-600 rounded text-gray-200 focus:outline-none focus:border-blue-500 w-48"
          />
          <button
            type="button"
            onClick={handleCancel}
            className="text-gray-400 hover:text-gray-200 text-xs px-1"
          >
            Cancel
          </button>
        </div>

        {/* Dropdown */}
        {showDropdown && filteredBranches.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-lg z-50"
          >
            {branchesData?.defaultBranch && !inputValue && (
              <div className="px-2 py-1 text-xs text-gray-500 border-b border-slate-700">
                Default branch
              </div>
            )}
            {branchesData?.defaultBranch && !inputValue && (
              <button
                type="button"
                onClick={() => handleSelectBranch(branchesData.defaultBranch!)}
                className="w-full px-3 py-1.5 text-left text-sm text-blue-400 hover:bg-slate-700 flex items-center gap-2"
              >
                <span>{branchesData.defaultBranch}</span>
                <span className="text-xs text-gray-500">(default)</span>
              </button>
            )}
            {filteredBranches.length > 0 && (
              <div className="px-2 py-1 text-xs text-gray-500 border-b border-slate-700">
                {inputValue ? 'Matching branches' : 'Local branches'}
              </div>
            )}
            {filteredBranches.map((branch) => (
              <button
                key={branch}
                type="button"
                onClick={() => handleSelectBranch(branch)}
                className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
              >
                {branch}
              </button>
            ))}
            {inputValue && (
              <>
                <div className="px-2 py-1 text-xs text-gray-500 border-t border-slate-700">
                  Use custom ref
                </div>
                <button
                  type="button"
                  onClick={() => handleSubmit(inputValue)}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
                >
                  Use &quot;{inputValue}&quot;
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleStartEdit}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-sm font-mono disabled:opacity-50 disabled:cursor-not-allowed group"
      title="Change base commit"
    >
      <span className="text-blue-400">{shortCommit || 'N/A'}</span>
      <EditIcon className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}
