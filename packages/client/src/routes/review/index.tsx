import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewQueueGroup } from '@agent-console/shared';
import { fetchReviewQueue } from '../../lib/api';
import { reviewQueueKeys } from '../../lib/query-keys';
import { useAppWsEvent } from '../../hooks/useAppWs';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { Spinner } from '../../components/ui/Spinner';

export const Route = createFileRoute('/review/')({
  component: ReviewQueuePage,
  head: () => ({
    meta: [{ title: 'Review Queue' }],
  }),
});

function ReviewQueuePage() {
  const queryClient = useQueryClient();

  const {
    data: groups,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: reviewQueueKeys.list(),
    queryFn: fetchReviewQueue,
  });

  // Real-time updates via WebSocket
  useAppWsEvent({
    onReviewQueueUpdated: () => {
      queryClient.invalidateQueries({ queryKey: reviewQueueKeys.root() });
    },
  });

  const totalPending = groups?.reduce(
    (sum, g) => sum + g.items.filter((i) => i.status === 'pending').length,
    0
  ) ?? 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Review Queue' },
      ]} />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Review Queue</h1>
          {totalPending > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-sm font-medium">
              {totalPending} pending
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isLoading}
          className="btn text-sm bg-slate-700 hover:bg-slate-600"
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading review queue...</span>
        </div>
      )}

      {/* Error State */}
      {!isLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load review queue</p>
          <button onClick={() => refetch()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {/* Group List */}
      {!isLoading && !error && groups && groups.length > 0 && (
        <div className="space-y-3">
          {groups.map((group) => (
            <ReviewGroupCard key={group.sourceSessionId} group={group} />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && groups && groups.length === 0 && (
        <div className="card text-center py-16">
          <p className="text-gray-400 text-lg mb-2">No reviews pending</p>
          <p className="text-gray-500 text-sm">
            When agents submit diffs for review, they will appear here.
          </p>
        </div>
      )}
    </div>
  );
}

function ReviewGroupCard({ group }: { group: ReviewQueueGroup }) {
  const pendingCount = group.items.filter((i) => i.status === 'pending').length;
  const totalComments = group.items.reduce((sum, i) => sum + i.commentCount, 0);

  // Find oldest pending item
  const oldestCreatedAt = group.items.reduce<string | null>((oldest, item) => {
    if (!oldest || item.createdAt < oldest) return item.createdAt;
    return oldest;
  }, null);

  const timeAgo = oldestCreatedAt ? formatRelativeTime(oldestCreatedAt) : '';

  return (
    <Link
      to="/review/$sourceSessionId"
      params={{ sourceSessionId: group.sourceSessionId }}
      className="card block hover:bg-slate-800/80 transition-colors no-underline"
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-medium truncate">
              {group.sourceSessionTitle || 'Untitled Session'}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium shrink-0">
              {pendingCount} pending
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{group.items.length} {group.items.length === 1 ? 'item' : 'items'} total</span>
            {totalComments > 0 && (
              <span>{totalComments} {totalComments === 1 ? 'comment' : 'comments'}</span>
            )}
            {timeAgo && <span>oldest: {timeAgo}</span>}
          </div>
        </div>
        <svg className="w-5 h-5 text-gray-500 shrink-0 ml-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}

/** Format ISO timestamp as relative time */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
