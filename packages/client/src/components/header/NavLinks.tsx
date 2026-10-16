import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { validateSessions } from '../../lib/api';
import { sessionKeys } from '../../lib/query-keys';
import { WarningIcon } from '../Icons';
import { TodoCountBadge } from './TodoCountBadge';
import { ReviewCountBadge } from './ReviewCountBadge';

export function TodosNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/todos');

  return (
    <Link
      to="/todos"
      className={`text-sm py-1 px-2 rounded no-underline flex items-center gap-1.5 ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Todo
      <TodoCountBadge />
    </Link>
  );
}

export function ArtifactsNavLink() {
  const location = useLocation();
  const isActive = location.pathname === '/artifacts' || location.pathname.startsWith('/artifacts/');

  return (
    <Link
      to="/artifacts"
      className={`text-sm py-1 px-2 rounded no-underline ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Artifacts
    </Link>
  );
}

export function ReviewNavLink() {
  const location = useLocation();
  const isActive = location.pathname.startsWith('/review');

  return (
    <Link
      to="/review"
      className={`text-sm py-1 px-2 rounded no-underline flex items-center gap-1.5 ${
        isActive ? 'text-white bg-white/10' : 'text-slate-400'
      }`}
    >
      Review
      <ReviewCountBadge />
    </Link>
  );
}

export function ValidationWarningIndicator() {
  const { data } = useQuery({
    queryKey: sessionKeys.validation(),
    queryFn: validateSessions,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });

  if (!data?.hasIssues) {
    return null;
  }

  const invalidCount = data.results.filter(r => !r.valid).length;

  return (
    <Link
      to="/maintenance"
      className="flex items-center gap-1.5 py-1 px-2 rounded bg-yellow-500/20 text-yellow-500 text-xs no-underline"
      title={`${invalidCount} invalid session${invalidCount > 1 ? 's' : ''} found`}
    >
      <WarningIcon className="w-3.5 h-3.5" />
      <span>{invalidCount}</span>
    </Link>
  );
}
