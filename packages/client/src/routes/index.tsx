import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSessions, deleteSession } from '../lib/api';
import type { Session } from '@agents-web-console/shared';

export const Route = createFileRoute('/')(  {
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cwd, setCwd] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const handleStartSession = () => {
    navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: 'new' },
      search: cwd ? { cwd } : undefined,
    });
  };

  const handleDeleteSession = (sessionId: string) => {
    if (confirm('Are you sure you want to stop this session?')) {
      deleteMutation.mutate(sessionId);
    }
  };

  const sessions = data?.sessions ?? [];

  return (
    <div className="p-5">
      <h1 className="mb-5 text-2xl font-semibold">Dashboard</h1>

      <div className="card mb-10">
        <h2 className="mb-4 text-lg font-medium">Start New Session</h2>
        <div className="flex gap-3 items-center">
          <input
            type="text"
            placeholder="Working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="input flex-1"
          />
          <button onClick={handleStartSession} className="btn btn-primary">
            Start Claude Code
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Leave empty to use the server&apos;s current directory
        </p>
      </div>

      <div>
        <h2 className="mb-4 text-lg font-medium">Active Sessions</h2>
        {isLoading && <p className="text-gray-500">Loading sessions...</p>}
        {error && <p className="text-red-500">Error loading sessions</p>}
        {!isLoading && sessions.length === 0 && (
          <p className="text-gray-500">No active sessions</p>
        )}
        <div className="flex flex-col gap-3">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onDelete={() => handleDeleteSession(session.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SessionCardProps {
  session: Session;
  onDelete: () => void;
}

function SessionCard({ session, onDelete }: SessionCardProps) {
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
      <button onClick={onDelete} className="btn btn-danger text-sm">
        Stop
      </button>
    </div>
  );
}
