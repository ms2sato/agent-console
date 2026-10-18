import { TODO_STATUSES, type TodoStatus } from '@agent-console/shared';

export type TodoStatusFilter = TodoStatus | 'all';

/** Both hosts (the `/todos` page and the session sidebar) start on the open items and do not remember the choice. */
export const DEFAULT_TODO_STATUS_FILTER: TodoStatusFilter = 'open';

interface TodoStatusSelectProps {
  value: TodoStatusFilter;
  onChange: (value: TodoStatusFilter) => void;
  ariaLabel?: string;
  /** False while the host is collapsed: the select leaves the tab order (fallback for engines without `inert`). */
  focusable?: boolean;
  className?: string;
}

/** The status filter select shared by the `/todos` page and the session sidebar panel: "All", then each status. */
export function TodoStatusSelect({
  value,
  onChange,
  ariaLabel = 'Status filter',
  focusable = true,
  className = 'input text-sm',
}: TodoStatusSelectProps) {
  return (
    <select
      tabIndex={focusable ? undefined : -1}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value as TodoStatusFilter)}
      className={className}
    >
      <option value="all">All</option>
      {TODO_STATUSES.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>
  );
}
