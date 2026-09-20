import type { ReactNode } from 'react';

interface AccordionSectionBodyProps {
  isExpanded: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Height-animated body wrapper for the session side rail's accordion
 * sections. Always mounted once the owning panel has decided to render
 * (R4') -- the open/closed transition is a CSS grid-template-rows state
 * change on the outer element with an overflow-hidden inner layer, never a
 * conditional mount/unmount (R6).
 *
 * This component owns the height transition, the `aria-hidden` flag, and
 * the tab-order exclusion of the collapsed body on the wrapper. When
 * collapsed, the wrapper also carries `inert`, which removes every
 * descendant -- the panel's own overflow-y-auto container, any nested
 * scroller, every control -- from the tab order and from Chrome's
 * keyboard-focusable scrollers behavior (a scroll container with no
 * focusable children is otherwise still a tab stop there), without
 * affecting layout or the animation.
 *
 * Each panel is still separately responsible for setting
 * `tabIndex={isExpanded ? undefined : -1}` on every interactive descendant
 * it renders inside this wrapper (buttons, inputs, links, and any
 * react-markdown-rendered anchors). That per-control convention remains
 * the fallback layer for engines without `inert` support -- defense in
 * depth alongside the wrapper-level `inert` above.
 */
export function AccordionSectionBody({ isExpanded, className, children }: AccordionSectionBodyProps) {
  return (
    <div
      aria-hidden={!isExpanded}
      inert={isExpanded ? undefined : ''}
      className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
    >
      <div className={`overflow-hidden min-w-0 ${className ?? ''}`}>{children}</div>
    </div>
  );
}
