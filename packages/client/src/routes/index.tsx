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
  openPath,
} from '../lib/api';
import { useDashboardWebSocket } from '../hooks/useDashboardWebSocket';
import { formatPath } from '../lib/path';
import { AgentSelector } from '../components/AgentSelector';
import { AgentManagement } from '../components/AgentManagement';
import type { Session, Repository, Worktree, AgentActivityState, CreateWorktreeRequest } from '@agent-console/shared';

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
function ActivityBadge({ state }: { state?: AgentActivityState }) {
  if (!state || state === 'unknown') return null;

  const styles: Record<string, string> = {
    asking: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-blue-500/20 text-blue-400',
    idle: 'bg-gray-500/20 text-gray-400',
  };

  const labels: Record<string, string> = {
    asking: 'Waiting',
    active: 'Working',
    idle: 'Idle',
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[state] ?? ''}`}>
      {labels[state] ?? state}
    </span>
  );
}

// Clickable path link component that opens the path in Finder/Explorer
function PathLink({ path, className = '' }: { path: string; className?: string }) {
  const handleClick = async () => {
    try {
      await openPath(path);
    } catch (err) {
      console.error('Failed to open path:', err);
    }
  };

  return (
    <span
      onClick={handleClick}
      className={`hover:text-blue-400 hover:underline cursor-pointer select-all ${className}`}
      title={`Open ${path} in Finder`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      {formatPath(path)}
    </span>
  );
}

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

// Helper to get primary agent worker's activity state
function getSessionActivityState(session: Session, workerActivityStates: Record<string, Record<string, AgentActivityState>>): AgentActivityState | undefined {
  const sessionWorkerStates = workerActivityStates[session.id];
  if (!sessionWorkerStates) return undefined;

  // Find the first agent worker
  const agentWorker = session.workers.find(w => w.type === 'agent');
  if (!agentWorker) return undefined;

  return sessionWorkerStates[agentWorker.id];
}

function DashboardPage() {
  const queryClient = useQueryClient();
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState('');
  // Track activity states locally for real-time updates: { sessionId: { workerId: state } }
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, Record<string, AgentActivityState>>>({});
  // Track previous states for detecting completion (active → idle)
  const prevStatesRef = useRef<Record<string, Record<string, AgentActivityState>>>({});
  // Track when each worker entered 'active' state (for minimum working time check)
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
  const handleSessionsSync = useCallback((sessions: Array<{ id: string; workers: Array<{ id: string; activityState?: AgentActivityState }> }>) => {
    console.log(`[Sync] Initializing ${sessions.length} sessions from WebSocket`);
    for (const session of sessions) {
      for (const worker of session.workers) {
        if (worker.activityState) {
          const key = `${session.id}:${worker.id}`;
          console.log(`[Sync] ${key}: ${worker.activityState}`);
          if (!prevStatesRef.current[session.id]) {
            prevStatesRef.current[session.id] = {};
          }
          prevStatesRef.current[session.id][worker.id] = worker.activityState;
          setWorkerActivityStates(prev => ({
            ...prev,
            [session.id]: { ...(prev[session.id] ?? {}), [worker.id]: worker.activityState! },
          }));
        }
      }
    }
  }, []);

  // Handle real-time activity updates via WebSocket
  // Note: ActivityDetector handles debouncing and sticky state transitions server-side
  const handleWorkerActivityUpdate = useCallback((sessionId: string, workerId: string, state: AgentActivityState) => {
    const key = `${sessionId}:${workerId}`;
    const prevState = prevStatesRef.current[sessionId]?.[workerId];
    const now = Date.now();

    console.log(`[Activity] ${key}: ${prevState} → ${state}`);

    // Update local state
    setWorkerActivityStates(prev => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? {}), [workerId]: state },
    }));
    if (!prevStatesRef.current[sessionId]) {
      prevStatesRef.current[sessionId] = {};
    }
    prevStatesRef.current[sessionId][workerId] = state;

    // Track when worker enters 'active' state
    if (state === 'active' && prevState !== 'active') {
      activeStartTimeRef.current[key] = now;
      console.log(`[Activity] ${key}: Started working at ${now}`);
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

    // Check if worker was working long enough
    const activeStartTime = activeStartTimeRef.current[key] || 0;
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
      const locationPath = session?.locationPath || '';
      // Extract project name from path
      const pathParts = locationPath.split('/').filter(Boolean);
      const projectName = pathParts[pathParts.length - 1] || 'Unknown';

      if (state === 'idle') {
        console.log('[Notification] Triggering: work completed');
        showNotification(
          'Claude completed work',
          `${projectName} - Work completed`,
          sessionId,
          `completed-${sessionId}-${now}`
        );
      } else if (state === 'asking') {
        console.log('[Notification] Triggering: waiting for input');
        showNotification(
          'Claude needs your input',
          `${projectName} - Waiting for input`,
          sessionId,
          `asking-${sessionId}-${now}`
        );
      }
    }
  }, []);

  // Connect to dashboard WebSocket for real-time updates
  useDashboardWebSocket({
    onSync: handleSessionsSync,
    onWorkerActivity: handleWorkerActivityUpdate,
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

  // Add activity state to sessions
  const sessions = (sessionsData?.sessions ?? []).map(session => ({
    ...session,
    activityState: getSessionActivityState(session, workerActivityStates),
  }));

  // Keep sessionsRef in sync for notification context
  useEffect(() => {
    sessionsRef.current = sessionsData?.sessions ?? [];
  }, [sessionsData]);

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
              sessions={sessions.filter((s) => s.type === 'worktree' && s.repositoryId === repo.id)}
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
      <QuickSessionsSection sessions={sessions.filter((s) => s.type === 'quick')} />

      {/* Settings Section */}
      <div className="mt-8">
        <h2 className="text-lg font-medium text-gray-400 mb-4">Settings</h2>
        <AgentManagement />
      </div>
    </div>
  );
}

type SessionWithActivity = Session & {
  activityState?: AgentActivityState;
};

interface RepositoryCardProps {
  repository: Repository;
  sessions: SessionWithActivity[];
  onUnregister: () => void;
}

type BranchNameMode = 'prompt' | 'custom' | 'existing';

function RepositoryCard({ repository, sessions, onUnregister }: RepositoryCardProps) {
  const queryClient = useQueryClient();
  const [showCreateWorktree, setShowCreateWorktree] = useState(false);
  const [branchNameMode, setBranchNameMode] = useState<BranchNameMode>('prompt');
  const [customBranch, setCustomBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const [initialPrompt, setInitialPrompt] = useState('');

  const { data: worktreesData } = useQuery({
    queryKey: ['worktrees', repository.id],
    queryFn: () => fetchWorktrees(repository.id),
  });

  const worktrees = worktreesData?.worktrees ?? [];

  // Open dialog with default settings
  const handleOpenCreateDialog = useCallback(() => {
    setBranchNameMode('prompt');
    setCustomBranch('');
    setBaseBranch('');
    setSelectedAgentId(undefined);
    setInitialPrompt('');
    setShowCreateWorktree(true);
  }, []);

  const { data: branchesData } = useQuery({
    queryKey: ['branches', repository.id],
    queryFn: () => fetchBranches(repository.id),
    enabled: showCreateWorktree, // Only fetch when modal is open
  });

  const defaultBranch = branchesData?.defaultBranch || 'main';

  const createWorktreeMutation = useMutation({
    mutationFn: (params: CreateWorktreeRequest) =>
      createWorktree(repository.id, params),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['worktrees', repository.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowCreateWorktree(false);
      setCustomBranch('');
      setBaseBranch('');
      setSelectedAgentId(undefined);
      setInitialPrompt('');
      if (data.session) {
        window.open(`/sessions/${data.session.id}`, '_blank');
      }
    },
  });

  const handleCreateWorktree = async () => {
    // Validate based on mode
    if (branchNameMode === 'prompt') {
      if (!initialPrompt.trim()) {
        alert('Initial prompt is required');
        return;
      }
    } else if (!customBranch.trim()) {
      alert('Branch name is required');
      return;
    }

    try {
      let request: CreateWorktreeRequest;

      switch (branchNameMode) {
        case 'prompt':
          request = {
            mode: 'prompt',
            initialPrompt: initialPrompt.trim(),
            baseBranch: baseBranch.trim() || undefined,
            autoStartSession: true,
            agentId: selectedAgentId,
          };
          break;
        case 'custom':
          request = {
            mode: 'custom',
            branch: customBranch.trim(),
            baseBranch: baseBranch.trim() || undefined,
            autoStartSession: true,
            agentId: selectedAgentId,
          };
          break;
        case 'existing':
          request = {
            mode: 'existing',
            branch: customBranch.trim(),
            autoStartSession: true,
            agentId: selectedAgentId,
          };
          break;
      }
      await createWorktreeMutation.mutateAsync(request);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create worktree');
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-medium">{repository.name}</h2>
          <PathLink path={repository.path} className="text-xs text-gray-500" />
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleOpenCreateDialog}
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
        <div className={`bg-slate-800 p-4 rounded mb-4 ${createWorktreeMutation.isPending ? 'opacity-70' : ''}`}>
          <h3 className="text-sm font-medium mb-3">
            {createWorktreeMutation.isPending ? 'Creating Worktree...' : 'Create Worktree'}
          </h3>
          <fieldset disabled={createWorktreeMutation.isPending} className="flex flex-col gap-3">
            {/* Branch name mode selection */}
            <div className="flex flex-col gap-2">
              <label className="text-sm text-gray-400 flex items-center gap-2">
                <input
                  type="radio"
                  name="branchMode"
                  checked={branchNameMode === 'prompt'}
                  onChange={() => setBranchNameMode('prompt')}
                />
                From initial prompt (recommended)
              </label>
              <label className="text-sm text-gray-400 flex items-center gap-2">
                <input
                  type="radio"
                  name="branchMode"
                  checked={branchNameMode === 'custom'}
                  onChange={() => setBranchNameMode('custom')}
                />
                Custom name (new branch)
              </label>
              <label className="text-sm text-gray-400 flex items-center gap-2">
                <input
                  type="radio"
                  name="branchMode"
                  checked={branchNameMode === 'existing'}
                  onChange={() => setBranchNameMode('existing')}
                />
                Use existing branch
              </label>
            </div>

            {/* Initial prompt input (for prompt mode) */}
            {branchNameMode === 'prompt' && (
              <textarea
                placeholder="What do you want to work on? (e.g., 'Add a dark mode toggle to the settings page')"
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                className="input min-h-[80px] resize-y"
                rows={3}
              />
            )}

            {/* Branch name input (only for custom/existing) */}
            {(branchNameMode === 'custom' || branchNameMode === 'existing') && (
              <input
                type="text"
                placeholder={branchNameMode === 'custom' ? 'New branch name' : 'Existing branch name'}
                value={customBranch}
                onChange={(e) => setCustomBranch(e.target.value)}
                className="input"
              />
            )}

            {/* Base branch input (only for new branches) */}
            {branchNameMode !== 'existing' && (
              <input
                type="text"
                placeholder={`Base branch (default: ${defaultBranch})`}
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="input"
              />
            )}

            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Agent:</span>
              <AgentSelector
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                className="flex-1"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateWorktree}
                className="btn btn-primary text-sm"
              >
                {createWorktreeMutation.isPending ? 'Creating...' : 'Create & Start Session'}
              </button>
              <button
                onClick={() => {
                  setShowCreateWorktree(false);
                  setCustomBranch('');
                  setBaseBranch('');
                  setSelectedAgentId(undefined);
                  setInitialPrompt('');
                }}
                className="btn btn-danger text-sm"
              >
                Cancel
              </button>
            </div>
          </fieldset>
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
              session={sessions.find((s) => s.locationPath === worktree.path)}
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
  session?: SessionWithActivity;
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
    onError: (error: Error, force: boolean) => {
      // If deletion failed without force and error mentions untracked/modified files, retry with force
      if (!force && error.message.includes('untracked')) {
        if (confirm(`Worktree has untracked files. Force delete "${worktree.branch}"?`)) {
          deleteWorktreeMutation.mutate(true);
        }
      } else {
        alert(error.message);
      }
    },
  });

  const handleStartSession = async () => {
    setIsStarting(true);
    try {
      const { session: newSession } = await createSession({
        type: 'worktree',
        repositoryId,
        worktreeId: worktree.branch,
        locationPath: worktree.path,
      });
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
    ? session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500'
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
        <PathLink path={worktree.path} className="text-xs text-gray-500 truncate" />
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
  sessions: SessionWithActivity[];
}

function QuickSessionsSection({ sessions }: QuickSessionsSectionProps) {
  const queryClient = useQueryClient();
  const [showAddSession, setShowAddSession] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);

  const handleStartSession = async () => {
    if (!newPath.trim()) return;
    setIsStarting(true);
    try {
      const { session } = await createSession({
        type: 'quick',
        locationPath: newPath.trim(),
        agentId: selectedAgentId,
      });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setShowAddSession(false);
      setNewPath('');
      setSelectedAgentId(undefined);
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
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Path (e.g., /path/to/project)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              className="input"
              onKeyDown={(e) => e.key === 'Enter' && handleStartSession()}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Agent:</span>
              <AgentSelector
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                className="flex-1"
              />
            </div>
            <div className="flex gap-3">
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
                  setSelectedAgentId(undefined);
                }}
                className="btn btn-danger text-sm"
              >
                Cancel
              </button>
            </div>
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
  session: SessionWithActivity;
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
    session.status === 'active'
      ? 'bg-green-500'
      : 'bg-gray-500';

  return (
    <div className="card flex items-center gap-4">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-2">
          <PathLink path={session.locationPath} className="truncate" />
          <ActivityBadge state={session.activityState} />
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Workers: {session.workers.length} | Started: {new Date(session.createdAt).toLocaleString()}
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
