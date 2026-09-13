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
 * This component only owns the height transition and the `aria-hidden`
 * flag on the wrapper. Each panel is separately responsible for setting
 * `tabIndex={isExpanded ? undefined : -1}` on every interactive descendant
 * it renders inside this wrapper (buttons, inputs, links, and any
 * react-markdown-rendered anchors) -- `aria-hidden` alone does not remove
 * an element from the keyboard tab order in every browser, so the
 * tabIndex on each control is what actually satisfies R6's "excluded from
 * tab order" requirement. `<AccordionSectionBody>` cannot do this itself
 * because it does not know what interactive elements its children render.
 */
export function AccordionSectionBody({ isExpanded, className, children }: AccordionSectionBodyProps) {
  return (
    <div
      aria-hidden={!isExpanded}
      className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
    >
      <div className={`overflow-hidden min-w-0 ${className ?? ''}`}>{children}</div>
    </div>
  );
}
