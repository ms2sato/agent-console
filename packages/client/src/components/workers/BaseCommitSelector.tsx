import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionBranches } from '../../lib/api';
import { sessionKeys } from '../../lib/query-keys';
import { EditIcon, GitForkIcon } from '../Icons';

interface BaseCommitSelectorProps {
  sessionId: string;
  currentBaseCommit: string | null;
  onBaseCommitChange: (ref: string) => void;
  disabled?: boolean;
}

const MERGE_BASE_SEARCH_TERMS = ['merge', 'fork', 'base', 'merge-base'];

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
    queryKey: sessionKeys.branches(sessionId),
    queryFn: () => fetchSessionBranches(sessionId),
    enabled: isEditing,
    staleTime: 30000, // Cache for 30 seconds
  });

  // Format display value - show commit hash clearly
  const shortCommit = currentBaseCommit ? currentBaseCommit.substring(0, 7) : null;

  const defaultBranch = branchesData?.defaultBranch ?? null;
  const mergeBaseRef = defaultBranch ? `merge-base:${defaultBranch}` : null;

  // Build dropdown items based on search state
  const { mergeBaseVisible, filteredLocal, filteredRemote, hasItems } = useMemo(() => {
    if (!branchesData) {
      return {
        mergeBaseVisible: false,
        filteredLocal: [],
        filteredRemote: [],
        hasItems: inputValue.trim().length > 0,
      };
    }

    const query = inputValue.toLowerCase();

    // Merge-base is visible when no search, or when search matches relevant terms
    const mbVisible = defaultBranch != null && (
      !inputValue ||
      MERGE_BASE_SEARCH_TERMS.some(term => term.includes(query)) ||
      defaultBranch.toLowerCase().includes(query)
    );

    // When not searching, exclude defaultBranch from regular lists (it appears in "Default branch" section)
    const localBranches = branchesData.local.filter(b => {
      if (!b.toLowerCase().includes(query)) return false;
      if (!inputValue && b === defaultBranch) return false;
      return true;
    });

    const remoteBranches = branchesData.remote.filter(b => {
      if (!b.toLowerCase().includes(query)) return false;
      if (!inputValue && b === `origin/${defaultBranch}`) return false;
      return true;
    });

    const total = (mbVisible ? 1 : 0) + localBranches.length + remoteBranches.length +
      (defaultBranch && !inputValue ? 2 : 0); // origin/default + local default

    return {
      mergeBaseVisible: mbVisible,
      filteredLocal: localBranches.slice(0, 10),
      filteredRemote: remoteBranches.slice(0, 10),
      hasItems: total > 0 || !!inputValue,
    };
  }, [branchesData, inputValue, defaultBranch]);

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
        {showDropdown && hasItems && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 mt-1 w-72 max-h-60 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-lg z-50"
          >
            {/* No search: show structured sections */}
            {!inputValue && defaultBranch && (
              <>
                {/* Recommended section */}
                {mergeBaseVisible && mergeBaseRef && (
                  <>
                    <SectionHeader label="Recommended" />
                    <button
                      type="button"
                      onClick={() => handleSelectBranch(mergeBaseRef)}
                      className="w-full px-3 py-1.5 text-left text-sm text-blue-300 hover:bg-slate-700 flex items-center gap-2"
                    >
                      <GitForkIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      <span>Fork point from {defaultBranch}</span>
                      <span className="text-xs text-gray-500 ml-auto">(merge-base)</span>
                    </button>
                  </>
                )}

                {/* Default branch section */}
                <SectionHeader label="Default branch" />
                <button
                  type="button"
                  onClick={() => handleSelectBranch(`origin/${defaultBranch}`)}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
                >
                  origin/{defaultBranch}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectBranch(defaultBranch)}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
                >
                  {defaultBranch}
                </button>
              </>
            )}

            {/* Searching: show merge-base if it matches */}
            {inputValue && mergeBaseVisible && mergeBaseRef && defaultBranch && (
              <button
                type="button"
                onClick={() => handleSelectBranch(mergeBaseRef)}
                className="w-full px-3 py-1.5 text-left text-sm text-blue-300 hover:bg-slate-700 flex items-center gap-2"
              >
                <GitForkIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span>Fork point from {defaultBranch}</span>
                <span className="text-xs text-gray-500 ml-auto">(merge-base)</span>
              </button>
            )}

            {/* Branches section */}
            {(filteredLocal.length > 0 || filteredRemote.length > 0) && (
              <>
                <SectionHeader label={inputValue ? 'Matching branches' : 'Branches'} />
                {filteredLocal.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => handleSelectBranch(branch)}
                    className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
                  >
                    {branch}
                  </button>
                ))}
                {filteredRemote.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => handleSelectBranch(branch)}
                    className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-slate-700"
                  >
                    {branch}
                  </button>
                ))}
              </>
            )}

            {/* Custom ref section */}
            {inputValue && (
              <>
                <SectionHeader label="Use custom ref" />
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

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 py-1 text-xs text-gray-500 border-b border-slate-700">
      {label}
    </div>
  );
}
