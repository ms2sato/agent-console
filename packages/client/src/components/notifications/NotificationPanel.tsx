import type { NotificationItem } from '@agent-console/shared';
import { NotificationItemRow } from './NotificationItemRow';

interface NotificationPanelProps {
  items: NotificationItem[];
  isLoading: boolean;
  onNavigate: () => void;
}

/**
 * Anchored dropdown panel body. Renders ONLY from `items` -- the props this
 * component receives are always the result of a `GET /api/notifications`
 * parse (N1: WebSocket broadcast payloads never reach this component).
 */
export function NotificationPanel({ items, isLoading, onNavigate }: NotificationPanelProps) {
  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-full z-40 mt-1 w-80 max-h-96 overflow-y-auto bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1"
    >
      {isLoading && (
        <div className="px-3 py-4 text-sm text-slate-400 text-center">Loading…</div>
      )}
      {!isLoading && items.length === 0 && (
        <div className="px-3 py-4 text-sm text-slate-400 text-center">No notifications yet</div>
      )}
      {!isLoading && items.length > 0 && (
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
