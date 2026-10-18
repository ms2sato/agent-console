import { useMemo } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import type { FileContentResponse } from '@agent-console/shared';
import { formatBytes } from '../../lib/format';
import { toRendererLanguage } from '../../lib/prism-grammar';
import { FileViewerLines } from './FileViewerLines';

/**
 * Highest `content.length` that is tokenised. Above it the file renders as
 * plain text: tokenising a whole file is one synchronous pass on the main
 * thread, and its cost grows with the file (see the measurements in the PR
 * that introduced the viewer).
 */
export const FILE_VIEWER_HIGHLIGHT_MAX_BYTES = 262144;

const textEncoder = new TextEncoder();

interface FileViewerContentProps {
  file: FileContentResponse;
}

/**
 * Right pane of the file viewer: path header, notices, and the file's lines.
 * Callers key it by path so a newly selected file starts at the top.
 */
export function FileViewerContent({ file }: FileViewerContentProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <div className="px-4 py-2 bg-slate-800 border-b border-gray-700 shrink-0 flex items-center gap-3 text-sm">
        <span className="font-mono text-gray-200 break-all min-w-0">{file.path}</span>
        <span className="text-gray-500 shrink-0">{formatBytes(file.size)}</span>
      </div>
      {file.kind === 'binary' ? (
        <Notice>Binary file ({formatBytes(file.size)}), content not shown.</Notice>
      ) : (
        <TextFile file={file} content={file.content ?? ''} />
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="px-4 py-1.5 bg-amber-900/30 border-b border-amber-700/50 text-xs text-amber-200 shrink-0">
      {children}
    </div>
  );
}

function TextFile({ file, content }: { file: FileContentResponse; content: string }) {
  // A trailing newline terminates the last line; it does not start another one.
  const code = content.endsWith('\n') ? content.slice(0, -1) : content;
  const highlight = content.length <= FILE_VIEWER_HIGHLIGHT_MAX_BYTES;
  const shownBytes = useMemo(
    () => (file.truncated ? textEncoder.encode(content).length : 0),
    [file.truncated, content]
  );

  return (
    <>
      {file.truncated && (
        <Notice>
          Showing the first {formatBytes(shownBytes)} of {formatBytes(file.size)}.
        </Notice>
      )}
      {!highlight && <Notice>highlighting off for files over 256 KiB</Notice>}
      {content.length === 0 ? (
        <Notice>Empty file.</Notice>
      ) : highlight ? (
        <HighlightedLines code={code} language={file.language} />
      ) : (
        <PlainLines code={code} />
      )}
    </>
  );
}

/** One `Highlight` over the whole file, so multi-line constructs tokenise correctly. */
function HighlightedLines({ code, language }: { code: string; language: string }) {
  return (
    <Highlight theme={themes.vsDark} code={code} language={toRendererLanguage(language)}>
      {({ tokens, getTokenProps }) => (
        <FileViewerLines
          lineCount={tokens.length}
          renderLine={(index) =>
            tokens[index].map((token, key) => <span key={key} {...getTokenProps({ token })} />)
          }
        />
      )}
    </Highlight>
  );
}

function PlainLines({ code }: { code: string }) {
  const lines = useMemo(() => code.split('\n'), [code]);
  return <FileViewerLines lineCount={lines.length} renderLine={(index) => lines[index]} />;
}
