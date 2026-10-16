import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { UntrustedLink, untrustedUrlTransform } from '../ui/UntrustedMarkdownLink';
import { MarkdownCodeBlock } from '../ui/MarkdownCodeBlock';

interface TodoBodyMarkdownProps {
  body: string;
  /** False when the block sits in a collapsed region: links and controls leave the tab order. */
  focusable: boolean;
  /** Present only where a terminal worker of the item's session can run a command block. */
  onRun?: (command: string) => void;
}

/** Renders a to-do item's body with the memo's markdown renderer and fenced-block chrome. */
export function TodoBodyMarkdown({ body, focusable, onRun }: TodoBodyMarkdownProps) {
  const tabIndex = focusable ? undefined : -1;
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={untrustedUrlTransform}
      components={{
        a: ({ href, children }) => (
          <UntrustedLink href={href} tabIndex={tabIndex}>
            {children}
          </UntrustedLink>
        ),
        pre: ({ children }) => (
          <MarkdownCodeBlock tabIndex={tabIndex} onRun={onRun}>
            {children}
          </MarkdownCodeBlock>
        ),
      }}
    >
      {body}
    </Markdown>
  );
}
