import { useNavigate, useLocation } from '@tanstack/react-router';
import type { AgentActivityState } from '@agent-console/shared';
import { ChevronLeftIcon, ChevronRightIcon } from '../Icons';
import { ActivityIndicator } from './ActivityIndicator';
import type { SessionWithActivity } from '../../hooks/useActiveSessionsWithActivity';

interface ActiveSessionsSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  sessions: SessionWithActivity[];
}

/**
 * Get display info for a session.
 * - Worktree: repository name (primary), branch/title (secondary)
 * - Quick: "Quick Session" (primary), path (secondary)
 */
function getSessionDisplayInfo(session: SessionWithActivity['session']): {
  primary: string;
  secondary: string;
  tooltip: string;
} {
  if (session.type === 'worktree') {
    const primary = session.repositoryName;
    const secondary = session.title || session.worktreeId;
    return {
      primary,
      secondary,
      tooltip: `${primary} / ${secondary}`,
    };
  }

  // Quick session
  const path = session.locationPath;
  // Truncate path for display, show full in tooltip
  const displayPath = path.replace(/^\/Users\/[^/]+/, '~');
  return {
    primary: 'Quick Session',
    secondary: displayPath,
    tooltip: `Quick Session: ${path}`,
  };
}

function getActivityLabel(state: AgentActivityState): string {
  switch (state) {
    case 'asking':
      return 'Waiting for input';
    case 'idle':
      return 'Idle';
    case 'active':
      return 'Working';
    default:
      return 'Unknown';
  }
}

interface SessionItemProps {
  sessionWithActivity: SessionWithActivity;
  collapsed: boolean;
  isActive: boolean;
  onClick: () => void;
}

function SessionItem({ sessionWithActivity, collapsed, isActive, onClick }: SessionItemProps) {
  const { session, activityState } = sessionWithActivity;
  const { primary, secondary, tooltip } = getSessionDisplayInfo(session);

  if (collapsed) {
    return (
      <button
        onClick={onClick}
        className={`w-full p-3 flex justify-center hover:bg-slate-800 transition-colors ${
          isActive ? 'bg-slate-800' : ''
        }`}
        title={`${tooltip} (${getActivityLabel(activityState)})`}
      >
        <ActivityIndicator state={activityState} />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={`w-full p-3 text-left hover:bg-slate-800 transition-colors ${
        isActive ? 'bg-slate-800' : ''
      }`}
      title={tooltip}
    >
      <div className="flex items-start gap-2">
        <ActivityIndicator state={activityState} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="text-gray-300 text-sm font-medium truncate">{primary}</div>
          <div className="text-gray-500 text-xs truncate">{secondary}</div>
        </div>
      </div>
    </button>
  );
}

export function ActiveSessionsSidebar({ collapsed, onToggle, sessions }: ActiveSessionsSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Extract current session ID from path if on session page
  const currentSessionId = location.pathname.startsWith('/sessions/')
    ? location.pathname.split('/')[2]
    : null;

  const handleSessionClick = (sessionId: string) => {
    navigate({ to: '/sessions/$sessionId', params: { sessionId } });
  };

  return (
    <aside
      className={`bg-slate-900 border-r border-slate-700 flex flex-col shrink-0 transition-all duration-200 ${
        collapsed ? 'w-12' : 'w-56'
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center border-b border-slate-700 shrink-0 ${
          collapsed ? 'justify-center p-2' : 'justify-between px-3 py-2'
        }`}
      >
        {!collapsed && (
          <span className="text-gray-400 text-xs font-medium uppercase tracking-wider">
            Active Sessions
          </span>
        )}
        <button
          onClick={onToggle}
          className="p-1 text-gray-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRightIcon className="w-4 h-4" />
          ) : (
            <ChevronLeftIcon className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          !collapsed && (
            <div className="p-3 text-gray-500 text-sm">No active sessions</div>
          )
        ) : (
          sessions.map(({ session, activityState }) => (
            <SessionItem
              key={session.id}
              sessionWithActivity={{ session, activityState }}
              collapsed={collapsed}
              isActive={session.id === currentSessionId}
              onClick={() => handleSessionClick(session.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
