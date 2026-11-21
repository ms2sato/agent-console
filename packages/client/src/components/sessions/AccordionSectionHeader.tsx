import type { ReactNode } from 'react';
import { ChevronRightIcon } from '../Icons';

interface AccordionSectionHeaderProps {
  label: string;
  isExpanded: boolean;
  onToggle: () => void;
  toggleAriaLabel: string;
  /** Trailing actions (e.g. Memo's Edit). Rendered beside the trigger, never inside it. */
  children?: ReactNode;
}

/**
 * Header strip of one session side rail section. The whole strip left of the
 * trailing actions is a single toggle button, so it reads and behaves as an
 * accordion trigger: its own background, a chevron (right when collapsed,
 * down when expanded), a hover highlight, and a line separating it from the
 * body when expanded.
 */
export function AccordionSectionHeader({
  label,
  isExpanded,
  onToggle,
  toggleAriaLabel,
  children,
}: AccordionSectionHeaderProps) {
  return (
    <div
      data-testid="accordion-section-header"
      className={`flex items-center bg-slate-900/40 ${isExpanded ? 'border-b border-slate-700' : ''}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={toggleAriaLabel}
        className="flex flex-1 items-center gap-1.5 px-3 py-2 min-w-0 text-left text-sm font-medium text-gray-300 bg-transparent border-none cursor-pointer hover:bg-slate-700/60"
      >
        <span
          aria-hidden="true"
          data-testid="accordion-section-chevron"
          className={`inline-flex shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        >
          <ChevronRightIcon className="w-4 h-4" />
        </span>
        <span className="truncate">{label}</span>
      </button>
      {children && <div className="flex shrink-0 items-center gap-1 pr-2">{children}</div>}
    </div>
  );
}
