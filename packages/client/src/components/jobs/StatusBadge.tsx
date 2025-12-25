import { JOB_STATUS, type JobStatus } from '@agent-console/shared';

const STATUS_COLORS: Record<JobStatus, string> = {
  [JOB_STATUS.PENDING]: 'bg-gray-500/20 text-gray-400',
  [JOB_STATUS.PROCESSING]: 'bg-blue-500/20 text-blue-400',
  [JOB_STATUS.COMPLETED]: 'bg-green-500/20 text-green-400',
  [JOB_STATUS.STALLED]: 'bg-red-500/20 text-red-400',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const colorClass = STATUS_COLORS[status] ?? 'bg-gray-500/20 text-gray-400';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${colorClass}`}
    >
      {status}
    </span>
  );
}
