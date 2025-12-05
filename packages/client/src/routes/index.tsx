import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchSessions,
  fetchRepositories,
  fetchWorktrees,
  fetchBranches,
  registerRepository,
  unregisterRepository,
  createSession,
  deleteSession,
  createWorktree,
  deleteWorktree,
} from '../lib/api';
import { useDashboardWebSocket } from '../hooks/useDashboardWebSocket';
import { formatPath } from '../lib/path';
import type { Session, Repository, Worktree, ClaudeActivityState } from '@agents-web-console/shared';

// Request notification permission on load
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Show browser notification
function showNotification(title: string, body: string, sessionId: string, tag: string) {
  console.log(`[showNotification] permission=${Notification.permission}, title=${title}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag, // Prevent duplicate notifications
    });
    console.log('[showNotification] Notification created');
    // Click to focus the session
    notification.onclick = () => {
      window.open(`/sessions/${sessionId}`, '_blank');
      notification.close();
    };
  } else {
    console.log('[showNotification] Permission not granted, skipping');
  }
}

// Activity state badge component
function ActivityBadge({ state }: { state?: ClaudeActivityState }) {
  if (!state || state === 'unknown') return null;

  const styles = {
    asking: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-blue-500/20 text-blue-400',
    idle: 'bg-gray-500/20 text-gray-400',
  };

  const labels = {
    asking: 'Waiting',
    active: 'Working',
    idle: 'Idle',
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[state]}`}>
      {labels[state]}
    </span>
  );
}

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const queryClient = useQueryClient();
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState('');
  // Track activity states locally for real-time updates
  const [activityStates, setActivityStates] = useState<Record<string, ClaudeActivityState>>({});
  // Track previous states for detecting completion (active → idle)
  const prevStatesRef = useRef<Record<string, ClaudeActivityState>>({});
  // Track when each session entered 'active' state (for minimum working time check)
  const activeStartTimeRef = useRef<Record<string, number>>({});
  // Track last notification time per session (for cooldown)
  const lastNotificationTimeRef = useRef<Record<string, number>>({});

  // Notification thresholds
  const MIN_WORKING_TIME_MS = 5000; // 5 seconds minimum working time
  const NOTIFICATION_COOLDOWN_MS = 30000; // 30 seconds between notifications

  // Keep sessions data in ref for notification context
  const sessionsRef = useRef<Session[]>([]);

  // Request notification permission on component mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Handle WebSocket sync (initializes prevStatesRef from server state)
  const handleSessionsSync = useCallback((sessions: Array<{ id: string; activityState: ClaudeActivityState }>) => {
    console.log(`[Sync] Initializing ${sessions.length} sessions from WebSocket`);
    for (const session of sessions) {
      console.log(`[Sync] ${session.id}: ${session.activityState}`);
      prevStatesRef.current[session.id] = session.activityState;
      setActivityStates(prev => ({ ...prev, [session.id]: session.activityState }));
    }
  }, []);

  // Handle real-time activity updates via WebSocket
  // Note: ActivityDetector handles debouncing and sticky state transitions server-side
  const handleActivityUpdate = useCallback((sessionId: string, state: ClaudeActivityState) => {
    const prevState = prevStatesRef.current[sessionId];
    const now = Date.now();

    console.log(`[Activity] ${sessionId}: ${prevState} → ${state}`);

    // Update local state
    setActivityStates(prev => ({ ...prev, [sessionId]: state }));
    prevStatesRef.current[sessionId] = state;

    // Track when session enters 'active' state
    if (state === 'active' && prevState !== 'active') {
      activeStartTimeRef.current[sessionId] = now;
      console.log(`[Activity] ${sessionId}: Started working at ${now}`);
    }

    // Skip notifications if this is the first state update (session just started)
    if (!prevState) {
      console.log('[Notification] Skipped: initial state');
      return;
    }

    // Only notify when page is hidden (user is not looking)
    if (document.visibilityState !== 'hidden') {
      console.log('[Notification] Skipped: page is visible');
      return;
    }

    // Check cooldown (don't notify same session too frequently)
    const lastNotification = lastNotificationTimeRef.current[sessionId] || 0;
    if (now - lastNotification < NOTIFICATION_COOLDOWN_MS) {
      console.log(`[Notification] Skipped: cooldown (${now - lastNotification}ms < ${NOTIFICATION_COOLDOWN_MS}ms)`);
      return;
    }

    // Check if session was working long enough
    const activeStartTime = activeStartTimeRef.current[sessionId] || 0;
    const workingTime = now - activeStartTime;
    const wasWorkingLongEnough = prevState === 'active' && workingTime >= MIN_WORKING_TIME_MS;

    // Send notification for work completion (active → idle or active → asking)
    if (prevState === 'active' && (state === 'idle' || state === 'asking')) {
      if (!wasWorkingLongEnough) {
        console.log(`[Notification] Skipped: working time too short (${workingTime}ms < ${MIN_WORKING_TIME_MS}ms)`);
        return;
      }

      lastNotificationTimeRef.current[sessionId] = now;

      // Get session info for notification body
      const session = sessionsRef.current.find(s => s.id === sessionId);
      const worktreePath = session?.worktreePath || '';
      // Extract project name and branch from path
      // Format: ~/.agents-web-console/worktrees/{org}/{repo}/{branch} or /path/to/project
      const pathParts = worktreePath.split('/').filter(Boolean);
      const isWorktree = worktreePath.includes('.agents-web-console/worktrees');
      let projectInfo: string;
      if (isWorktree && pathParts.length >= 2) {
        // Last part is branch, second-to-last is repo (or org/repo)
        const branch = pathParts[pathParts.length - 1];
        const repo = pathParts[pathParts.length - 2];
        projectInfo = `${repo} (${branch})`;
      } else {
        // Main repo - just use directory name
        projectInfo = pathParts[pathParts.length - 1] || 'Unknown';
      }

      if (state === 'idle') {
        console.log('[Notification] Triggering: work completed');
        showNotification(
          'Claude completed work',
          `${projectInfo} - Work completed`,
          sessionId,
          `completed-${sessionId}-${now}`
        );
      } else if (state === 'asking') {
        console.log('[Notification] Triggering: waiting for input');
        showNotification(
          'Claude needs your input',
          `${projectInfo} - Waiting for input`,
          sessionId,
          `asking-${sessionId}-${now}`
        );
      }
    }
  }, []);

  // Connect to dashboard WebSocket for real-time updates
  useDashboardWebSocket({
    onSync: handleSessionsSync,
    onActivity: handleActivityUpdate,
  });

  const { data: reposData } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  // Merge server session data with local real-time activity states
  const sessions = (sessionsData?.sessions ?? []).map(session => ({
    ...session,
    activityState: activityStates[session.id] ?? session.activityState,
  }));

  // Keep sessionsRef in sync for notification context
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const registerMutation = useMutation({
    mutationFn: registerRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
      setShowAddRepo(false);
      setNewRepoPath('');
    },
  });

  const unregisterMutation = useMutation({
    mutationFn: unregisterRepository,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repositories'] });
    },
  });

  const repositories = reposData?.repositories ?? [];

  const handleAddRepo = async () => {
    if (!newRepoPath.trim()) return;
    try {
      await registerMutation.mutateAsync(newRepoPath.trim());
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to register repository');
    }
  };

  return (
    <div className="py-6 px-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <button
          onClick={() => setShowAddRepo(true)}
          className="btn btn-primary text-sm"
        >
          + Add Repository
        </button>
      </div>

      {showAddRepo && (
        <div className="card mb-5">
          <h2 className="mb-3 text-lg font-medium">Add Repository</h2>
          <div className="flex gap-3 items-center">
            <input
              type="text"
              placeholder="Repository path (e.g., /path/to/repo)"
              value={newRepoPath}
              onChange={(e) => setNewRepoPath(e.target.value)}
              className="input flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAddRepo()}
            />
            <button
              onClick={handleAddRepo}
              disabled={registerMutation.isPending}
              className="btn btn-primary"
            >
              {registerMutation.isPending ? 'Adding...' : 'Add'}
            </button>
            <button
              onClick={() => {
                setShowAddRepo(false);
                setNewRepoPath('');
              }}
              className="btn btn-danger"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {repositories.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-4">No repositories registered</p>
          <button
            onClick={() => setShowAddRepo(true)}
            className="btn btn-primary"
          >
            Add your first repository
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {repositories.map((repo) => (
            <RepositoryCard
              key={repo.id}
              repository={repo}
              sessions={sessions.filter((s) => s.repositoryId === repo.id)}
              onUnregister={() => {
                if (confirm(`Unregister ${repo.name}?`)) {
                  unregisterMutation.mutate(repo.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Quick Sessions (sessions without a registered repository) */}
      <QuickSessionsSection sessions={sessions.filter((s) => s.repositoryId === 'default')} />
    </div>
  );
}

interface RepositoryCardProps {
  repository: Repository;
  sessions: Session[];
  onUnregister: () => void;
}

function RepositoryCard({ repository, sessions, onUnregister }: RepositoryCardProps) {
  const queryClient = useQueryClient();
  const [showCreateWorktree, setShowCreateWorktree] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [isNewBranch, setIsNewBranch] = useState(false);

  const { data: worktreesData } = useQuery({
    queryKey: ['worktrees', repository.id],
    queryFn: () => fetchWorktrees(repository.id),
  });

  const { data: branchesData } = useQuery({
    queryKey: ['branches', repository.id],
    queryFn: () => fetchBranches(repository.id),
    enabled: showCreateWorktree, // Only fetch when modal is open
  });

  const defaultBranch = branchesData?.defaultBranch || 'main';

  const createWorktreeMutation = useMutation({
    mutationFn: (params: { branch: string; baseBranch?: string }) =>
      createWorktree(repository.id, {
        branch: params.branch,
        baseBranch: params.baseBranch,
        autoStartSession: true,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['worktrees', repository.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowCreateWorktree(false);
      setNewBranch('');
      setBaseBranch('');
      // Open terminal in new tab if session was created
      if (data.session) {
        window.open(`/sessions/${data.session.id}`, '_blank');
      }
    },
  });

  const worktrees = worktreesData?.worktrees ?? [];

  const handleCreateWorktree = async () => {
    if (!newBranch.trim()) return;
    try {
      await createWorktreeMutation.mutateAsync({
        branch: newBranch.trim(),
        baseBranch: isNewBranch ? baseBranch.trim() || defaultBranch : undefined,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create worktree');
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-medium">{repository.name}</h2>
          <p className="text-xs text-gray-500">{formatPath(repository.path)}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateWorktree(true)}
            className="btn btn-primary text-sm"
          >
            + Worktree
          </button>
          <button onClick={onUnregister} className="btn btn-danger text-sm">
            Remove
          </button>
        </div>
      </div>

      {showCreateWorktree && (
        <div className="bg-slate-800 p-4 rounded mb-4">
          <h3 className="text-sm font-medium mb-3">Create Worktree</h3>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 items-center">
              <label className="text-sm text-gray-400">
                <input
                  type="checkbox"
                  checked={isNewBranch}
                  onChange={(e) => setIsNewBranch(e.target.checked)}
                  className="mr-2"
                />
                Create new branch
              </label>
            </div>
            <input
              type="text"
              placeholder={isNewBranch ? 'New branch name' : 'Existing branch name'}
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              className="input"
            />
            {isNewBranch && (
              <input
                type="text"
                placeholder={`Base branch (default: ${defaultBranch})`}
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="input"
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={handleCreateWorktree}
                disabled={createWorktreeMutation.isPending}
                className="btn btn-primary text-sm"
              >
                {createWorktreeMutation.isPending ? 'Creating...' : 'Create & Start Session'}
              </button>
              <button
                onClick={() => {
                  setShowCreateWorktree(false);
                  setNewBranch('');
                  setBaseBranch('');
                }}
                className="btn btn-danger text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {worktrees.length === 0 ? (
        <p className="text-sm text-gray-500">No worktrees</p>
      ) : (
        <div className="flex flex-col gap-2">
          {[...worktrees].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              session={sessions.find((s) => s.worktreePath === worktree.path)}
              repositoryId={repository.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WorktreeRowProps {
  worktree: Worktree;
  session?: Session;
  repositoryId: string;
}

function WorktreeRow({ worktree, session, repositoryId }: WorktreeRowProps) {
  const queryClient = useQueryClient();
  const [isStarting, setIsStarting] = useState(false);

  const deleteWorktreeMutation = useMutation({
    mutationFn: (force: boolean) => deleteWorktree(repositoryId, worktree.path, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worktrees', repositoryId] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const handleStartSession = async () => {
    setIsStarting(true);
    try {
      const { session: newSession } = await createSession(worktree.path, repositoryId);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      window.open(`/sessions/${newSession.id}`, '_blank');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setIsStarting(false);
    }
  };

  const handleDeleteWorktree = () => {
    if (worktree.isMain) {
      alert('Cannot delete main worktree');
      return;
    }
    const force = session !== undefined;
    const msg = force
      ? `Delete worktree "${worktree.branch}"? This will also terminate the running session.`
      : `Delete worktree "${worktree.branch}"?`;
    if (confirm(msg)) {
      deleteWorktreeMutation.mutate(force);
    }
  };

  const statusColor = session
    ? session.status === 'running'
      ? 'bg-green-500'
      : session.status === 'idle'
        ? 'bg-yellow-500'
        : 'bg-red-500'
    : 'bg-gray-600';

  return (
    <div className="flex items-center gap-3 p-2 bg-slate-800 rounded">
      {/* Index number - 0 for main, 1+ for worktrees */}
      <span className="w-6 text-center text-sm font-mono text-gray-500 shrink-0">
        {worktree.index !== undefined ? worktree.index : '0'}
      </span>
      <span className={`inline-block w-2 h-2 rounded-full ${statusColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {worktree.branch}
          {worktree.isMain && (
            <span className="text-xs text-gray-500">(primary)</span>
          )}
          {session && <ActivityBadge state={session.activityState} />}
        </div>
        <div className="text-xs text-gray-500 truncate">{formatPath(worktree.path)}</div>
      </div>
      <div className="flex gap-2 shrink-0">
        {session ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="btn btn-primary text-xs no-underline"
          >
            Open
          </Link>
        ) : (
          <button
            onClick={handleStartSession}
            disabled={isStarting}
            className="btn btn-primary text-xs"
          >
            {isStarting ? 'Starting...' : 'Start'}
          </button>
        )}
        {!worktree.isMain && (
          <button
            onClick={handleDeleteWorktree}
            disabled={deleteWorktreeMutation.isPending}
            className="btn btn-danger text-xs"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

interface QuickSessionsSectionProps {
  sessions: Session[];
}

function QuickSessionsSection({ sessions }: QuickSessionsSectionProps) {
  const queryClient = useQueryClient();
  const [showAddSession, setShowAddSession] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [isStarting, setIsStarting] = useState(false);

  const handleStartSession = async () => {
    if (!newPath.trim()) return;
    setIsStarting(true);
    try {
      const { session } = await createSession(newPath.trim(), 'default');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowAddSession(false);
      setNewPath('');
      window.open(`/sessions/${session.id}`, '_blank');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-gray-400">Quick Sessions</h2>
        <button
          onClick={() => setShowAddSession(true)}
          className="btn text-sm bg-slate-700 hover:bg-slate-600"
        >
          + Quick Start
        </button>
      </div>

      {showAddSession && (
        <div className="card mb-4 bg-slate-800">
          <h3 className="text-sm font-medium mb-3">Start Session in Any Directory</h3>
          <div className="flex gap-3 items-center">
            <input
              type="text"
              placeholder="Path (e.g., /path/to/project)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              className="input flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleStartSession()}
              autoFocus
            />
            <button
              onClick={handleStartSession}
              disabled={isStarting}
              className="btn btn-primary text-sm"
            >
              {isStarting ? 'Starting...' : 'Start'}
            </button>
            <button
              onClick={() => {
                setShowAddSession(false);
                setNewPath('');
              }}
              className="btn btn-danger text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {sessions.length === 0 && !showAddSession && (
        <p className="text-sm text-gray-500">
          Start a Claude session in any directory without setting up a worktree.
        </p>
      )}

      {sessions.length > 0 && (
        <div className="flex flex-col gap-3">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionCardProps {
  session: Session;
}

function SessionCard({ session }: SessionCardProps) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const statusColor =
    session.status === 'running'
      ? 'bg-green-500'
      : session.status === 'idle'
        ? 'bg-yellow-500'
        : 'bg-red-500';

  return (
    <div className="card flex items-center gap-4">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-2">
          <span className="truncate">{formatPath(session.worktreePath)}</span>
          <ActivityBadge state={session.activityState} />
        </div>
        <div className="text-xs text-gray-500 mt-1">
          PID: {session.pid} | Started: {new Date(session.startedAt).toLocaleString()}
        </div>
      </div>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        className="btn btn-primary text-sm no-underline"
      >
        Open
      </Link>
      <button
        onClick={() => {
          if (confirm('Stop this session?')) {
            deleteMutation.mutate(session.id);
          }
        }}
        className="btn btn-danger text-sm"
      >
        Stop
      </button>
    </div>
  );
}
