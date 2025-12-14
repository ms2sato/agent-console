import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GitDiffTarget } from '@agent-console/shared';
import { fetchBranchCommits } from '../../lib/api';
import { EditIcon } from '../Icons';

interface TargetRefSelectorProps {
  sessionId: string;
  currentTargetRef: GitDiffTarget;
  currentBaseCommit: string | null;
  onTargetRefChange: (ref: GitDiffTarget) => void;
  disabled?: boolean;
}

export function TargetRefSelector({
  sessionId,
  currentTargetRef,
  currentBaseCommit,
  onTargetRefChange,
  disabled = false,
}: TargetRefSelectorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Fetch commits since base commit when editing starts
  const { data: commitsData } = useQuery({
    queryKey: ['branchCommits', sessionId, currentBaseCommit],
    queryFn: () => fetchBranchCommits(sessionId, currentBaseCommit!),
    enabled: isEditing && !!currentBaseCommit,
    staleTime: 10000, // Cache for 10 seconds
  });

  // Format display value
  const isWorkingDir = currentTargetRef === 'working-dir';
  const shortCommit = !isWorkingDir ? currentTargetRef.substring(0, 7) : null;

  const handleStartEdit = useCallback(() => {
    if (disabled) return;
    setIsEditing(true);
    setShowDropdown(true);
  }, [disabled]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setShowDropdown(false);
  }, []);

  const handleSelect = useCallback((value: GitDiffTarget) => {
    onTargetRefChange(value);
    setIsEditing(false);
    setShowDropdown(false);
  }, [onTargetRefChange]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
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
        <button
          ref={buttonRef}
          type="button"
          onClick={handleCancel}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-slate-600 rounded text-sm font-mono"
        >
          {isWorkingDir ? (
            <span className="text-green-400">Working Dir</span>
          ) : (
            <span className="text-yellow-400">{shortCommit}</span>
          )}
          <span className="text-gray-400 text-xs">▲</span>
        </button>

        {/* Dropdown */}
        {showDropdown && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 mt-1 w-80 max-h-72 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-lg z-50"
          >
            {/* Working Directory option - always show first */}
            <div className="px-2 py-1 text-xs text-gray-500 border-b border-slate-700">
              Current state
            </div>
            <button
              type="button"
              onClick={() => handleSelect('working-dir')}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-slate-700 flex items-center gap-2 ${
                isWorkingDir ? 'text-green-400 bg-slate-700/50' : 'text-gray-200'
              }`}
            >
              <span>Working Directory</span>
              <span className="text-xs text-gray-500">(uncommitted changes)</span>
            </button>

            {/* HEAD option */}
            <button
              type="button"
              onClick={() => handleSelect('HEAD')}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-slate-700 flex items-center gap-2 ${
                currentTargetRef === 'HEAD' ? 'text-yellow-400 bg-slate-700/50' : 'text-gray-200'
              }`}
            >
              <span>HEAD</span>
              <span className="text-xs text-gray-500">(latest commit)</span>
            </button>

            {/* Commits created in this branch */}
            {commitsData && commitsData.commits.length > 0 && (
              <>
                <div className="px-2 py-1 text-xs text-gray-500 border-t border-b border-slate-700">
                  Commits in this branch ({commitsData.commits.length})
                </div>
                {commitsData.commits.map((commit) => (
                  <button
                    key={commit.hash}
                    type="button"
                    onClick={() => handleSelect(commit.hash)}
                    className={`w-full px-3 py-1.5 text-left text-sm hover:bg-slate-700 ${
                      currentTargetRef === commit.hash ? 'text-yellow-400 bg-slate-700/50' : 'text-gray-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-yellow-400">{commit.shortHash}</span>
                      <span className="truncate flex-1">{commit.message}</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {/* No commits message */}
            {commitsData && commitsData.commits.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-500 border-t border-slate-700">
                No commits yet in this branch
              </div>
            )}

            {/* Loading state */}
            {!commitsData && currentBaseCommit && (
              <div className="px-3 py-2 text-xs text-gray-500 border-t border-slate-700">
                Loading commits...
              </div>
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
      title="Change target"
    >
      {isWorkingDir ? (
        <span className="text-green-400">Working Dir</span>
      ) : (
        <span className="text-yellow-400">{shortCommit}</span>
      )}
      <EditIcon className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}
