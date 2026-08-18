import { Link } from '@tanstack/react-router';
import type { NotificationItem } from '@agent-console/shared';
import { formatTimestamp } from '../../lib/format';

interface NotificationItemRowProps {
  item: NotificationItem;
  /** Called after the user activates a row (used to close the panel). */
  onNavigate: () => void;
}

/**
 * A single notification row: kind-appropriate deep link + title + relative
 * time. `artifact-created` uses a plain `<a>` per #1340's jail rule
 * (artifact pages must stay outside the SPA router). All other kinds use a
 * normal TanStack Router `<Link>`.
 */
export function NotificationItemRow({ item, onNavigate }: NotificationItemRowProps) {
  const relativeTime = formatTimestamp(new Date(item.occurredAt).getTime());
  const isFailed = item.outcome === 'failed';

  const content = (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={`text-sm truncate ${isFailed ? 'text-red-400' : 'text-slate-200'}`}>
        {item.title}
      </span>
      <span className="text-xs text-slate-500">{relativeTime}</span>
    </div>
  );

  const rowClassName = `block px-3 py-2 no-underline hover:bg-slate-700/60 ${
    isFailed ? 'border-l-2 border-red-500' : 'border-l-2 border-transparent'
  }`;

  if (item.kind === 'artifact-created') {
    return (
      <a
        href={item.link}
        target="_blank"
        rel="noopener noreferrer"
        className={rowClassName}
        data-testid="notification-item"
        data-kind={item.kind}
        onClick={onNavigate}
      >
        {content}
      </a>
    );
  }

  if (item.kind === 'worktree-deletion-finished') {
    return (
      <Link
        to={item.link as string}
        className={rowClassName}
        data-testid="notification-item"
        data-kind={item.kind}
        onClick={onNavigate}
      >
        {content}
      </Link>
    );
  }

  // Exhaustive guard: NotificationItem.kind is a closed union.
  const _exhaustive: never = item.kind;
  throw new Error(`Unhandled notification kind: ${String(_exhaustive)}`);
}
