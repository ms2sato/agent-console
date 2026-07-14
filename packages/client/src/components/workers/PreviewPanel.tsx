import { useState, useEffect } from 'react';
import { createPreviewBlobUrl } from '../../lib/preview-sandbox';

interface PreviewPanelProps {
  code: string;
  lang: 'html' | 'svg';
}

/**
 * Collapsed-by-default "Preview" toggle rendered below a fenced HTML/SVG
 * code block in an assistant chat message. Security-critical:
 * the `<iframe>` element is lazy-mounted (only created after the user
 * clicks "Preview") and, once mounted, has `sandbox=""` with NO tokens --
 * do not add any token (including `allow-scripts` / `allow-same-origin` /
 * `allow-popups`) without an explicit architect review; see
 * `lib/preview-sandbox.ts` for the sanitizer + CSP this depends on.
 */
export function PreviewPanel({ code, lang }: PreviewPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Lazy blob-URL creation, gated on `expanded`: untrusted content must not
  // even be sanitized/parsed until the user opts in by clicking "Preview".
  // Cleanup revokes the blob URL both on collapse (dep change) and on
  // `code` changing while still expanded, preventing a blob URL leak.
  useEffect(() => {
    if (!expanded) return;
    const url = createPreviewBlobUrl(code);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [expanded, code]);

  return (
    <div className="mt-1 rounded border border-slate-700 bg-slate-800/60 text-xs overflow-hidden">
      <div className="flex border-b border-slate-700">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={`px-3 py-1.5 ${
            expanded ? 'text-gray-400 hover:text-gray-200' : 'bg-slate-700/60 text-gray-100'
          }`}
          aria-pressed={!expanded}
        >
          Code
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`px-3 py-1.5 ${
            expanded ? 'bg-slate-700/60 text-gray-100' : 'text-gray-400 hover:text-gray-200'
          }`}
          aria-pressed={expanded}
        >
          Preview
        </button>
      </div>
      {expanded && blobUrl && (
        <iframe
          src={blobUrl}
          sandbox=""
          referrerPolicy="no-referrer"
          title={`${lang} preview`}
          className="w-full h-64 border-t border-slate-700 bg-white"
        />
      )}
    </div>
  );
}
