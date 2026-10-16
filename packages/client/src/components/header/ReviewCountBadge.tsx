import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchReviewQueue } from '../../lib/api';
import { reviewQueueKeys } from '../../lib/query-keys';
import { useAppWsEvent } from '../../hooks/useAppWs';

/** The number of pending review-queue items; renders nothing at zero. */
export function ReviewCountBadge() {
  const queryClient = useQueryClient();

  const { data: groups } = useQuery({
    queryKey: reviewQueueKeys.list(),
    queryFn: fetchReviewQueue,
  });

  // Real-time updates via WebSocket
  useAppWsEvent({
    onReviewQueueUpdated: () => {
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  const pendingCount = groups?.reduce((sum, g) => sum + g.items.length, 0) ?? 0;
  if (pendingCount === 0) return null;

  return (
    <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium leading-none">
      {pendingCount}
    </span>
  );
}
