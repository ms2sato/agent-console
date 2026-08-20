import { useState } from 'react';
import { useSessionBookmarks } from './hooks/useSessionBookmarks';

interface SessionBookmarksPanelProps {
  sessionId: string;
}

/**
 * Session-scoped bookmark list + registration form, presented alongside
 * `MemoPanel` and `SessionArtifactsPanel`. Structurally
 * mirrors `SessionArtifactsPanel`'s collapse/expand sidebar shell; unlike
 * artifacts, the list is human-registered (there is no MCP tool for
 * bookmarks in v1), so this panel always renders a form even when the list
 * is empty -- there must be a way to add the first bookmark.
 *
 * Navigation safety (S4): a bookmark points at an external origin, so it
 * does not and cannot have the artifact's `frame-src` jail or opaque-origin
 * boundary (#1340) -- an external origin is outside our CSP's reach. What
 * protects the user is the registration-time scheme allowlist (server-side,
 * `http:`/`https:` only) plus this render-time `rel`/`target`/text-node
 * discipline; the safety of the destination itself is not guaranteed. This
 * is acceptable in the v1 threat model because a person opens a URL they
 * pasted themselves. If v1's human-only registration ever changes to allow
 * agent registration over MCP, this premise must be re-derived -- an agent
 * that supplies a friendly title for a malicious URL opens a phishing
 * surface, and scheme validation alone would no longer be sufficient.
 */
export function SessionBookmarksPanel({ sessionId }: SessionBookmarksPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { bookmarks, isPending, addBookmark, deleteBookmark } = useSessionBookmarks(sessionId);

  // Render nothing while genuinely pending with no cached data yet -- once
  // resolved (even to an empty list), the panel stays mounted so the add
  // form is always reachable.
  if (isPending) {
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    addBookmark(url.trim(), title.trim() || undefined, {
      onSuccess: () => {
        setUrl('');
        setTitle('');
      },
      onError: (err) => setError(err.message || 'Failed to add bookmark'),
    });
  }

  // Collapsed state - show thin strip with toggle button
  if (!isExpanded) {
    return (
      <div className="hidden md:flex flex-col items-center border-l border-slate-700 bg-slate-800 py-2 px-1">
        <button
          onClick={() => setIsExpanded(true)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1"
          title="Expand bookmarks"
          aria-label="Expand bookmarks"
        >
          <span className="text-xs" style={{ writingMode: 'vertical-rl' }}>Bookmarks</span>
        </button>
      </div>
    );
  }

  // Expanded sidebar
  return (
    <div className="hidden md:flex flex-col w-80 border-l border-slate-700 bg-slate-800 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700">
        <span className="text-sm font-medium text-gray-300">Bookmarks</span>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-none p-1 text-sm"
          title="Collapse bookmarks"
          aria-label="Collapse bookmarks"
        >
          ✕
        </button>
      </div>

      {/* Add form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 px-3 py-2 border-b border-slate-700">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          aria-label="Bookmark URL"
          className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-200 placeholder:text-slate-500"
        />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          aria-label="Bookmark title"
          className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-gray-200 placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={url.trim().length === 0}
          className="btn text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed self-start"
        >
          Add bookmark
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {bookmarks.map((bookmark) => (
          <div
            key={bookmark.id}
            className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-700/50"
          >
            <a
              href={bookmark.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 truncate no-underline"
              title={bookmark.title ?? bookmark.url}
            >
              {bookmark.title ?? bookmark.url}
            </a>
            <button
              onClick={() => deleteBookmark(bookmark.id)}
              className="text-gray-400 hover:text-red-400 cursor-pointer bg-transparent border-none p-1 text-xs shrink-0"
              title="Delete bookmark"
              aria-label={`Delete bookmark ${bookmark.title ?? bookmark.url}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
