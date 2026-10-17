import * as v from 'valibot';
import { JOB_STATUSES, JOB_TYPES } from '../types/job.js';

const NonNegativeCount = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Wire shape of a job record as returned by the jobs routes.
 */
export const JobSchema = v.strictObject({
  id: v.string(),
  type: v.picklist(Object.values(JOB_TYPES)),
  // Decision: the payload is opaque on the wire. Its union (a handler-owned
  // shape per job type, or a parse-error marker) is validated by the job
  // handlers that consume it; the UI only renders it as JSON. The envelope is
  // strict, the payload is not modelled here.
  payload: v.unknown(),
  status: v.picklist(JOB_STATUSES),
  priority: v.number(),
  attempts: v.number(),
  maxAttempts: v.number(),
  nextRetryAt: v.number(),
  lastError: v.nullable(v.string()),
  createdAt: v.number(),
  startedAt: v.nullable(v.number()),
  completedAt: v.nullable(v.number()),
});

/**
 * Response of GET /api/jobs.
 */
export const JobsResponseSchema = v.strictObject({
  jobs: v.array(JobSchema),
  total: NonNegativeCount,
});

/**
 * Response of GET /api/jobs/stats (bare counts, no envelope).
 */
export const JobStatsSchema = v.strictObject({
  pending: NonNegativeCount,
  processing: NonNegativeCount,
  completed: NonNegativeCount,
  stalled: NonNegativeCount,
});

export type JobWire = v.InferOutput<typeof JobSchema>;
export type JobsResponseWire = v.InferOutput<typeof JobsResponseSchema>;
export type JobStatsWire = v.InferOutput<typeof JobStatsSchema>;
