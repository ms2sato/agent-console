import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { JOB_STATUS, JOB_TYPES, type Job, type JobStatus, type JobType, type InboundEventJobPayload } from '@agent-console/shared';
import { fetchJobs, fetchJobStats, retryJob, cancelJob, type FetchJobsParams } from '../../lib/api';
import { formatTimestamp } from '../../lib/format';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { StatusBadge } from '../../components/jobs';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';

export const Route = createFileRoute('/jobs/')({
  component: JobsPage,
  head: () => ({
    meta: [{ title: 'Jobs' }],
  }),
});

type FilterStatus = JobStatus | 'all';
type FilterType = JobType | 'all';

const JOB_TYPE_LABELS: Record<JobType, string> = {
  [JOB_TYPES.CLEANUP_SESSION_OUTPUTS]: 'Session Outputs Cleanup',
  [JOB_TYPES.CLEANUP_WORKER_OUTPUT]: 'Worker Output Cleanup',
  [JOB_TYPES.CLEANUP_REPOSITORY]: 'Repository Cleanup',
  [JOB_TYPES.INBOUND_EVENT_PROCESS]: 'Webhook Event',
};

function JobsPage() {
  const queryClient = useQueryClient();
  const { errorDialogProps, showError } = useErrorDialog();

  // Filter state
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');

  // Job to cancel (for confirmation dialog)
  const [jobToCancel, setJobToCancel] = useState<Job | null>(null);

  // Build query params
  const queryParams: FetchJobsParams = {
    limit: 50,
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(typeFilter !== 'all' && { type: typeFilter }),
  };

  // Fetch jobs with auto-refresh
  const {
    data: jobsData,
    isLoading: isLoadingJobs,
    error: jobsError,
    refetch: refetchJobs,
  } = useQuery({
    queryKey: ['jobs', queryParams],
    queryFn: () => fetchJobs(queryParams),
    refetchInterval: 5000,
  });

  // Fetch job stats with auto-refresh
  const {
    data: stats,
    isLoading: isLoadingStats,
    error: statsError,
  } = useQuery({
    queryKey: ['jobs', 'stats'],
    queryFn: fetchJobStats,
    refetchInterval: 5000,
  });

  // Retry mutation
  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => {
      showError('Failed to Retry Job', error.message);
    },
  });

  // Cancel mutation
  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setJobToCancel(null);
    },
    onError: (error) => {
      setJobToCancel(null);
      showError('Failed to Cancel Job', error.message);
    },
  });

  const isLoading = isLoadingJobs || isLoadingStats;
  const error = jobsError || statsError;
  const jobs = jobsData?.jobs ?? [];

  const handleRetry = (job: Job) => {
    retryMutation.mutate(job.id);
  };

  const handleCancelClick = (job: Job) => {
    setJobToCancel(job);
  };

  const handleConfirmCancel = () => {
    if (jobToCancel) {
      cancelMutation.mutate(jobToCancel.id);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">
          Agent Console
        </Link>
        <span>/</span>
        <span className="text-white">Jobs</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <button
          onClick={() => refetchJobs()}
          disabled={isLoading}
          className="btn text-sm bg-slate-700 hover:bg-slate-600"
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Pending"
          count={stats?.pending ?? 0}
          colorClass="text-gray-400"
          isLoading={isLoadingStats}
        />
        <StatCard
          label="Processing"
          count={stats?.processing ?? 0}
          colorClass="text-blue-400"
          isLoading={isLoadingStats}
        />
        <StatCard
          label="Completed"
          count={stats?.completed ?? 0}
          colorClass="text-green-400"
          isLoading={isLoadingStats}
        />
        <StatCard
          label="Stalled"
          count={stats?.stalled ?? 0}
          colorClass="text-red-400"
          isLoading={isLoadingStats}
        />
      </div>

      {/* Quick Filters */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => {
            setTypeFilter('all');
            setStatusFilter('all');
          }}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            typeFilter === 'all'
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
          }`}
        >
          All Jobs
        </button>
        <button
          onClick={() => {
            setTypeFilter(JOB_TYPES.INBOUND_EVENT_PROCESS);
            setStatusFilter('all');
          }}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            typeFilter === JOB_TYPES.INBOUND_EVENT_PROCESS
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
          }`}
        >
          Webhook Events
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="flex items-center gap-2">
          <label htmlFor="status-filter" className="text-sm text-gray-400">
            Status:
          </label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FilterStatus)}
            className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">All</option>
            <option value={JOB_STATUS.PENDING}>Pending</option>
            <option value={JOB_STATUS.PROCESSING}>Processing</option>
            <option value={JOB_STATUS.COMPLETED}>Completed</option>
            <option value={JOB_STATUS.STALLED}>Stalled</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="type-filter" className="text-sm text-gray-400">
            Type:
          </label>
          <select
            id="type-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as FilterType)}
            className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">All</option>
            <option value={JOB_TYPES.CLEANUP_SESSION_OUTPUTS}>
              {JOB_TYPE_LABELS[JOB_TYPES.CLEANUP_SESSION_OUTPUTS]}
            </option>
            <option value={JOB_TYPES.CLEANUP_WORKER_OUTPUT}>
              {JOB_TYPE_LABELS[JOB_TYPES.CLEANUP_WORKER_OUTPUT]}
            </option>
            <option value={JOB_TYPES.CLEANUP_REPOSITORY}>
              {JOB_TYPE_LABELS[JOB_TYPES.CLEANUP_REPOSITORY]}
            </option>
            <option value={JOB_TYPES.INBOUND_EVENT_PROCESS}>
              {JOB_TYPE_LABELS[JOB_TYPES.INBOUND_EVENT_PROCESS]}
            </option>
          </select>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading jobs...</span>
        </div>
      )}

      {/* Error State */}
      {!isLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load jobs</p>
          <button onClick={() => refetchJobs()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {/* Jobs Table */}
      {!isLoading && !error && jobs.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left py-3 px-4 font-medium text-gray-400">Type</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Status</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Created</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Started</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Completed</th>
                <th className="text-left py-3 px-4 font-medium text-gray-400">Attempts</th>
                <th className="text-right py-3 px-4 font-medium text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onRetry={handleRetry}
                  onCancel={handleCancelClick}
                  isRetrying={retryMutation.isPending && retryMutation.variables === job.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && jobs.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500">No jobs found</p>
        </div>
      )}

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        open={jobToCancel !== null}
        onOpenChange={(open) => !open && setJobToCancel(null)}
        title="Cancel Job"
        description={`Are you sure you want to cancel this ${jobToCancel?.type ?? ''} job?`}
        confirmLabel="Cancel Job"
        variant="danger"
        onConfirm={handleConfirmCancel}
        isLoading={cancelMutation.isPending}
      />

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

interface StatCardProps {
  label: string;
  count: number;
  colorClass: string;
  isLoading: boolean;
}

function StatCard({ label, count, colorClass, isLoading }: StatCardProps) {
  return (
    <div className="card">
      <div className="text-sm text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${colorClass}`}>
        {isLoading ? <Spinner size="sm" /> : count}
      </div>
    </div>
  );
}

interface JobRowProps {
  job: Job;
  onRetry: (job: Job) => void;
  onCancel: (job: Job) => void;
  isRetrying: boolean;
}

function JobRow({ job, onRetry, onCancel, isRetrying }: JobRowProps) {
  const canRetry = job.status === JOB_STATUS.STALLED;
  const canCancel = job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.STALLED;

  // Extract webhook-specific info from payload
  const isWebhookJob = job.type === JOB_TYPES.INBOUND_EVENT_PROCESS;
  const webhookPayload = isWebhookJob ? (job.payload as InboundEventJobPayload) : null;

  return (
    <tr className="border-b border-slate-700/50 hover:bg-slate-800/50">
      <td className="py-3 px-4">
        <Link
          to="/jobs/$jobId"
          params={{ jobId: job.id }}
          className="font-mono text-xs text-blue-400 hover:underline"
        >
          {JOB_TYPE_LABELS[job.type] ?? job.type}
        </Link>
        {webhookPayload && (
          <div className="text-xs text-gray-500 mt-0.5">
            Source: {webhookPayload.service}
          </div>
        )}
      </td>
      <td className="py-3 px-4">
        <StatusBadge status={job.status} />
      </td>
      <td className="py-3 px-4 text-gray-400">
        {formatTimestamp(job.createdAt)}
      </td>
      <td className="py-3 px-4 text-gray-400">
        {job.startedAt ? formatTimestamp(job.startedAt) : '-'}
      </td>
      <td className="py-3 px-4 text-gray-400">
        {job.completedAt ? formatTimestamp(job.completedAt) : '-'}
      </td>
      <td className="py-3 px-4 text-gray-400">
        {job.attempts}/{job.maxAttempts}
      </td>
      <td className="py-3 px-4 text-right">
        <div className="flex justify-end gap-2">
          {canRetry && (
            <button
              onClick={() => onRetry(job)}
              disabled={isRetrying}
              className="btn text-xs bg-blue-600 hover:bg-blue-500"
            >
              {isRetrying ? 'Retrying...' : 'Retry'}
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => onCancel(job)}
              className="btn btn-danger text-xs"
            >
              Cancel
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
