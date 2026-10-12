import { isValidElement, type ReactNode } from 'react';
import { linkHost } from '../../lib/link-host';

// Link rendering for agent-authored markdown, the class "agent-supplied link
// text rendered clickable inside the operator console". Its two
// `react-markdown` consumers are MemoPanel and EmbeddedAgentWorkerView's
// assistant messages; both pass `untrustedUrlTransform` as `urlTransform` and
// `UntrustedLink` as the `a` component, so the two surfaces cannot drift.

// Only absolute http(s) URLs keep an href. react-markdown 10.x's
// `defaultUrlTransform` already strips `javascript:`-class schemes; this
// allowlist makes the wall ours and narrower (`mailto:` and relative paths
// are dropped too -- agent-authored text has no legitimate relative target
// in these panels), and is re-verified on react-markdown bumps by the link
// tests of both consumers. Returning '' makes react-markdown render the link
// text without an href.
export function untrustedUrlTransform(url: string): string {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function childrenText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenText).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return childrenText(children.props.children);
  return '';
}

// The author's link text stays; the real destination host is appended unless
// the visible text already is the URL or its host (an autolink or bare URL).
export function UntrustedLink({ href, tabIndex, children }: { href?: string; tabIndex?: number; children?: ReactNode }) {
  // `untrustedUrlTransform` drops every non-http(s) href, fragment-only ones
  // included, so an absent href is rendered as plain text.
  if (!href) return <>{children}</>;
  const host = linkHost(href);
  const text = childrenText(children).trim();
  const showHost = text !== href && text !== host && text !== href.replace(/\/$/, '');
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer" tabIndex={tabIndex}>{children}</a>
      {showHost && <span className="text-gray-500"> ({host})</span>}
    </>
  );
}
