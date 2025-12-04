import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchSessions,
  fetchRepositories,
  fetchWorktrees,
  registerRepository,
  unregisterRepository,
  createSession,
  deleteSession,
  createWorktree,
  deleteWorktree,
} from '../lib/api';
import type { Session, Repository, Worktree } from '@agents-web-console/shared';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const queryClient = useQueryClient();
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState('');

  const { data: reposData } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

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
  const sessions = sessionsData?.sessions ?? [];

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

      {/* Orphan Sessions (sessions without a registered repository) */}
      {sessions.filter((s) => s.repositoryId === 'default').length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-lg font-medium text-gray-400">Other Sessions</h2>
          <div className="flex flex-col gap-3">
            {sessions
              .filter((s) => s.repositoryId === 'default')
              .map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
          </div>
        </div>
      )}
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
        baseBranch: isNewBranch ? baseBranch.trim() || 'main' : undefined,
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
          <p className="text-xs text-gray-500">{repository.path}</p>
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
                placeholder="Base branch (default: main)"
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
          {worktrees.map((worktree) => (
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
      <span className={`inline-block w-2 h-2 rounded-full ${statusColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">
          {worktree.branch}
          {worktree.isMain && (
            <span className="ml-2 text-xs text-gray-500">(main)</span>
          )}
        </div>
        <div className="text-xs text-gray-500 truncate">{worktree.path}</div>
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
        <div className="text-sm text-gray-200 overflow-hidden text-ellipsis whitespace-nowrap">
          {session.worktreePath}
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
