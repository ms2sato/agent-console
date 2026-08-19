import type { NotificationItem } from '@agent-console/shared';
import { NotificationItemRow } from './NotificationItemRow';

interface NotificationPanelProps {
  items: NotificationItem[];
  isLoading: boolean;
  onNavigate: () => void;
  /** Associates the panel with its trigger button via `aria-controls`. */
  id?: string;
  /** The backing `GET /api/notifications` fetch failed -- render the error
   * state instead of silently falling through to the empty-state copy. */
  isError: boolean;
  /** Wired to the query's `refetch` -- lets the user retry without closing
   * the panel. */
  onRetry: () => void;
}

/**
 * Anchored dropdown panel body. Renders ONLY from `items` -- the props this
 * component receives are always the result of a `GET /api/notifications`
 * parse (N1: WebSocket broadcast payloads never reach this component).
 *
 * `isError` is rendered as its own state, distinct from "no items yet":
 * collapsing a failed fetch into the empty-state copy would be the same
 * misleading-silence failure mode Ruling 3 / N1 exists to prevent, just on
 * the fetch-error axis instead of the broadcast axis.
 */
export function NotificationPanel({ items, isLoading, onNavigate, id, isError, onRetry }: NotificationPanelProps) {
  return (
    <div
      id={id}
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-full z-40 mt-1 w-80 max-h-96 overflow-y-auto bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1"
    >
      {isLoading && (
        <div className="px-3 py-4 text-sm text-slate-400 text-center">Loading…</div>
      )}
      {!isLoading && isError && (
        <div className="px-3 py-4 text-center">
          <p className="text-sm text-red-400 mb-2">Failed to load notifications</p>
          <button onClick={onRetry} className="btn btn-primary text-sm">
            Retry
          </button>
        </div>
      )}
      {!isLoading && !isError && items.length === 0 && (
        <div className="px-3 py-4 text-sm text-slate-400 text-center">No notifications yet</div>
      )}
      {!isLoading && !isError && items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <NotificationItemRow item={item} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
