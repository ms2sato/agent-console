import { useState } from 'react';
import { useSessionBookmarks } from './hooks/useSessionBookmarks';

interface SessionBookmarksPanelProps {
  sessionId: string;
}

// Host is always re-derived from the URL at render time -- never stored or
// passed through from a registrant-supplied string (design doc §3.3/§7).
// `URL`'s IDNA normalization also closes the homograph-domain path as a side
// effect of parsing: a confusable Unicode host renders in its Punycode
// (`xn--...`) form.
function bookmarkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Session-scoped bookmark list + registration form, presented alongside
 * `MemoPanel` and `SessionArtifactsPanel`. Structurally
 * mirrors `SessionArtifactsPanel`'s collapse/expand sidebar shell. Bookmarks
 * can be registered by a human (through the form below) or by an agent
 * (through the `create_bookmark` MCP tool) -- this panel always renders the
 * form even when the list is empty, so there is always a way to add the
 * first bookmark by hand.
 *
 * Navigation safety and the click-time threat model (agent vs. human
 * registration, the host-display invariant, why REST and MCP use different
 * identity anchors) are specified in `docs/design/session-bookmarks.md` --
 * this component implements that spec; do not restate the reasoning here.
 */
export function SessionBookmarksPanel({ sessionId }: SessionBookmarksPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { bookmarks, isPending, isAddingBookmark, addBookmark, deleteBookmark } = useSessionBookmarks(sessionId);

  // Render nothing while genuinely pending with no cached data yet -- once
  // resolved (even to an empty list), the panel stays mounted so the add
  // form is always reachable.
  if (isPending) {
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isAddingBookmark) {
      return;
    }
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
          disabled={url.trim().length === 0 || isAddingBookmark}
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
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <a
                  href={bookmark.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 text-sm text-blue-400 hover:text-blue-300 truncate no-underline"
                  style={{ unicodeBidi: 'isolate' }}
                >
                  {bookmark.title ?? bookmark.url}
                </a>
                {bookmark.origin === 'agent' && (
                  <span
                    className="shrink-0 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium leading-none"
                    aria-label="Registered by an agent"
                  >
                    Agent
                  </span>
                )}
              </div>
              <span className="block break-all text-xs text-gray-500">{bookmarkHost(bookmark.url)}</span>
            </div>
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
