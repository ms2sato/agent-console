import { useState } from 'react';
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { JOB_STATUS } from '@agent-console/shared';
import { fetchJob, retryJob, cancelJob } from '../../../lib/api';
import { jobKeys } from '../../../lib/query-keys';
import { formatAbsoluteTimestamp } from '../../../lib/format';
import { PageBreadcrumb } from '../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../components/PageErrorFallback';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { SectionHeader, DetailRow } from '../../../components/ui/detail-layout';
import { ErrorDialog, useErrorDialog } from '../../../components/ui/error-dialog';
import { StatusBadge } from '../../../components/jobs';

export const Route = createFileRoute('/jobs/$jobId/')({
  component: JobDetailPage,
  pendingComponent: JobDetailPending,
  errorComponent: JobDetailError,
  head: () => ({ meta: [{ title: 'Job Details' }] }),
});

export function JobDetailPending() {
  return <PagePendingFallback message="Loading job..." />;
}

export function JobDetailError({ error, reset }: ErrorComponentProps) {
  return (
    <PageErrorFallback
      error={error}
      reset={reset}
      breadcrumbItems={[
        { label: 'Agent Console', to: '/' },
        { label: 'Jobs', to: '/jobs' },
        { label: 'Error' },
      ]}
      errorMessage="Failed to load job"
      backTo="/jobs"
      backLabel="Back to Jobs"
    />
  );
}

function JobDetailPage() {
  const { jobId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showRetryConfirm, setShowRetryConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data: job } = useSuspenseQuery({
    queryKey: jobKeys.detail(jobId),
    queryFn: () => fetchJob(jobId),
    refetchInterval: 5000, // Auto-refresh every 5 seconds
  });

  const retryMutation = useMutation({
    mutationFn: () => retryJob(jobId),
    onSuccess: async () => {
      setShowRetryConfirm(false);
      await queryClient.invalidateQueries({ queryKey: jobKeys.detail(jobId) });
      await queryClient.invalidateQueries({ queryKey: jobKeys.root() });
      await queryClient.invalidateQueries({ queryKey: jobKeys.stats() });
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
      await queryClient.invalidateQueries({ queryKey: jobKeys.root() });
      await queryClient.invalidateQueries({ queryKey: jobKeys.stats() });
      navigate({ to: '/jobs' });
    },
    onError: (error) => {
      setShowCancelConfirm(false);
      showError('Failed to Cancel Job', error.message);
    },
  });

  const canRetry = job.status === JOB_STATUS.STALLED;
  const canCancel = job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.STALLED;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Jobs', to: '/jobs' },
        { label: job.type },
      ]} />

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
        description="Are you sure you want to retry this job? It will be queued for processing again."
        confirmLabel="Retry"
        variant="default"
        onConfirm={() => retryMutation.mutate()}
        isLoading={retryMutation.isPending}
      />

      {/* Cancel Confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onOpenChange={setShowCancelConfirm}
        title="Cancel Job"
        description="Are you sure you want to cancel this job? This action cannot be undone."
        confirmLabel="Cancel Job"
        variant="danger"
        onConfirm={() => cancelMutation.mutate()}
        isLoading={cancelMutation.isPending}
      />

      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
