import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyIcon } from '../Icons';
import { copyToClipboard } from '../../lib/clipboard';
import { logger } from '../../lib/logger';

// Fenced code blocks in agent-authored markdown get a one-click Copy control
// (the owner copies the command an agent wrote into a terminal; the TUI's
// hard-wrapping makes the terminal view a poor place to copy from). Its
// `react-markdown` consumer is MemoPanel; it is routed in as the `pre`
// component, which is how react-markdown 10.x separates a fenced block from
// inline code: it has no `inline` prop any more, a fenced block is a `pre`
// whose single child is a `code` element, while inline code is a bare `code`
// element with no `pre` parent -- so overriding `pre` (and leaving `code`
// alone) touches fenced blocks only. The ```terminal tag is deliberately NOT
// required: a Copy control is harmless on any block.

const COPIED_LABEL_MS = 1500;

function childrenText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenText).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return childrenText(children.props.children);
  return '';
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

/**
 * The exact text a Copy click puts on the clipboard: the block's raw code
 * string with the one trailing newline a fenced block always carries removed.
 * No wrapping, no prompt stripping, no other transformation.
 */
export function codeBlockCopyText(children: ReactNode): string {
  return childrenText(children).replace(/\n$/, '');
}

export function MarkdownCodeBlock({ children, tabIndex }: { children?: ReactNode; tabIndex?: number }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const codeElement = isValidElement<CodeElementProps>(children) ? children : null;
  const className = codeElement?.props.className;
  const codeChildren = codeElement ? codeElement.props.children : children;
  const text = codeBlockCopyText(codeChildren);

  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
    } catch (err) {
      logger.error('Failed to copy code block:', err);
      return;
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
  };

  return (
    <div data-testid="markdown-code-block" className="relative group">
      <pre>
        <code className={className}>{codeChildren}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy code"
        tabIndex={tabIndex}
        onClick={handleCopy}
        className="absolute top-1 right-1 flex items-center gap-1 rounded bg-slate-700 px-1.5 py-1 text-xs text-gray-200 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus:opacity-100 hover:bg-slate-600"
      >
        {copied ? <span role="status">Copied!</span> : <CopyIcon className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
