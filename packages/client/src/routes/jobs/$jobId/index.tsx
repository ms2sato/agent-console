import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { JOB_STATUS } from '@agent-console/shared';
import { fetchJob, retryJob, cancelJob } from '../../../lib/api';
import { formatAbsoluteTimestamp } from '../../../lib/format';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { StatusBadge } from '../../../components/jobs';
import { ErrorDialog, useErrorDialog } from '../../../components/ui/error-dialog';
import { Spinner } from '../../../components/ui/Spinner';

export const Route = createFileRoute('/jobs/$jobId/')({
  component: JobDetailPage,
  head: () => ({ meta: [{ title: 'Job Details' }] }),
});

function JobDetailPage() {
  const { jobId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showRetryConfirm, setShowRetryConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data: job, isLoading, error } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => fetchJob(jobId),
    refetchInterval: 5000, // Auto-refresh every 5 seconds
  });

  const retryMutation = useMutation({
    mutationFn: () => retryJob(jobId),
    onSuccess: async () => {
      setShowRetryConfirm(false);
      await queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs', 'stats'] });
    },
    onError: (error) => {
      setShowRetryConfirm(false);
      showError('Failed to Retry Job', error.message);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelJob(jobId),
    onSuccess: async () => {
      setShowCancelConfirm(false);
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs', 'stats'] });
      navigate({ to: '/jobs' });
    },
    onError: (error) => {
      setShowCancelConfirm(false);
      showError('Failed to Cancel Job', error.message);
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading job...</span>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
          <Link to="/" className="hover:text-white">Agent Console</Link>
          <span>/</span>
          <Link to="/jobs" className="hover:text-white">Jobs</Link>
          <span>/</span>
          <span className="text-white">Not Found</span>
        </div>
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Job not found</p>
          <Link to="/jobs" className="btn btn-primary">
            Back to Jobs
          </Link>
        </div>
      </div>
    );
  }

  const canRetry = job.status === JOB_STATUS.STALLED;
  const canCancel = job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.STALLED;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/jobs" className="hover:text-white">Jobs</Link>
        <span>/</span>
        <span className="text-white">{job.type}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{job.type}</h1>
          <StatusBadge status={job.status} />
        </div>
        <div className="flex gap-2">
          {canRetry && (
            <button
              onClick={() => setShowRetryConfirm(true)}
              className="btn btn-primary text-sm"
            >
              Retry
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => setShowCancelConfirm(true)}
              className="btn btn-danger text-sm"
            >
              Cancel
            </button>
          )}
          <Link to="/jobs" className="btn btn-secondary text-sm no-underline">
            Back to List
          </Link>
        </div>
      </div>

      {/* Job Details */}
      <div className="card">
        {/* Error Display */}
        {job.lastError && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <h4 className="text-sm font-medium text-red-400 mb-2">Last Error</h4>
            <p className="text-sm text-red-300 font-mono whitespace-pre-wrap">{job.lastError}</p>
          </div>
        )}

        {/* Overview Section */}
        <SectionHeader title="Overview" />
        <div className="space-y-4 mb-6">
          <DetailRow label="ID" value={job.id} mono />
          <DetailRow label="Type" value={job.type} mono />
          <DetailRow label="Status" value={job.status} />
          <DetailRow label="Priority" value={String(job.priority)} />
        </div>

        {/* Timing Section */}
        <SectionHeader title="Timing" />
        <div className="space-y-4 mb-6">
          <DetailRow label="Created" value={formatAbsoluteTimestamp(job.createdAt)} />
          <DetailRow
            label="Started"
            value={job.startedAt ? formatAbsoluteTimestamp(job.startedAt) : '(not started)'}
            muted={!job.startedAt}
          />
          <DetailRow
            label="Completed"
            value={job.completedAt ? formatAbsoluteTimestamp(job.completedAt) : '(not completed)'}
            muted={!job.completedAt}
          />
          {job.nextRetryAt > 0 && job.status !== JOB_STATUS.COMPLETED && (
            <DetailRow label="Next Retry At" value={formatAbsoluteTimestamp(job.nextRetryAt)} />
          )}
        </div>

        {/* Execution Section */}
        <SectionHeader title="Execution" />
        <div className="space-y-4 mb-6">
          <DetailRow label="Attempts" value={`${job.attempts} / ${job.maxAttempts}`} />
        </div>

        {/* Payload Section */}
        <SectionHeader title="Payload" />
        <div className="mb-6">
          <pre className="p-4 bg-slate-900 rounded-lg text-sm text-gray-300 font-mono overflow-x-auto">
            {JSON.stringify(job.payload, null, 2)}
          </pre>
        </div>
      </div>

      {/* Retry Confirmation */}
      <ConfirmDialog
        open={showRetryConfirm}
        onOpenChange={setShowRetryConfirm}
        title="Retry Job"
        description={`Are you sure you want to retry this job? It will be queued for processing again.`}
        confirmLabel="Retry"
        variant="default"
        onConfirm={() => {
          retryMutation.mutate();
        }}
        isLoading={retryMutation.isPending}
      />

      {/* Cancel Confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onOpenChange={setShowCancelConfirm}
        title="Cancel Job"
        description={`Are you sure you want to cancel this job? This action cannot be undone.`}
        confirmLabel="Cancel Job"
        variant="danger"
        onConfirm={() => {
          cancelMutation.mutate();
        }}
        isLoading={cancelMutation.isPending}
      />

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3 pb-1 border-b border-slate-700">
      {title}
    </h3>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}

function DetailRow({ label, value, mono, muted }: DetailRowProps) {
  return (
    <div className="flex">
      <span className="w-32 text-gray-400 shrink-0">{label}:</span>
      <span
        className={`${mono ? 'font-mono text-sm' : ''} ${
          muted ? 'text-gray-600' : 'text-gray-200'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
