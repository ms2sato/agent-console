import { useState } from 'react';
import { useSessionArtifacts } from './hooks/useSessionArtifacts';
import { formatTimestamp } from '../../lib/format';

interface SessionArtifactsPanelProps {
  sessionId: string;
}

/**
 * Session-scoped HTML artifact list, presented like `MemoPanel` (Issue
 * #1370 -- owner request: "surface a session's own artifacts, like the Memo
 * feature"). Structurally mirrors `MemoPanel`'s collapse/expand sidebar and
 * its "render nothing while pending or empty" behavior; content differs
 * (an artifact list instead of rendered markdown).
 *
 * Deep links to an artifact use a plain `<a target="_blank">`, never an SPA
 * `<Link>` -- artifact pages must stay outside the SPA router (#1340 jail
 * rule), same as `NotificationItemRow`'s `artifact-created` link and
 * `routes/artifacts/index.tsx`'s `ArtifactRow`.
 */
export function SessionArtifactsPanel({ sessionId }: SessionArtifactsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const { data: artifacts, isPending } = useSessionArtifacts(sessionId);

  // Don't render anything while loading, or when the session has no artifacts.
  if (isPending || artifacts == null || artifacts.length === 0) {
    return null;
  }

  // Collapsed state - show thin strip with toggle button
  if (!isExpanded) {
    return (
      <div className="hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1">
        <button
          onClick={() => setIsExpanded(true)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
          title="Expand artifacts"
          aria-label="Expand artifacts"
        >
          <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>Artifacts</span>
        </button>
      </div>
    );
  }

  // Expanded sidebar
  return (
    <div className="hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700">
        <span className="text-sm font-medium text-gray-300">Artifacts</span>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-sm"
          title="Collapse artifacts"
          aria-label="Collapse artifacts"
        >
          ✕
        </button>
      </div>
      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {artifacts.map((artifact) => (
          <div
            key={artifact.id}
            className="flex flex-col gap-0.5 px-3 py-2 border-b border-slate-700/50"
          >
            <span className="text-sm text-gray-200 truncate" title={artifact.title}>
              {artifact.title}
            </span>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">
                {formatTimestamp(new Date(artifact.createdAt).getTime())}
              </span>
              <a
                href={`/artifacts/${artifact.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn text-xs bg-blue-600 hover:bg-blue-500 no-underline"
              >
                View
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
