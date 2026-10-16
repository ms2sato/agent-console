import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { JobSchema, JobsResponseSchema, JobStatsSchema } from '../job.js';
import type { Job, JobsResponse, JobStats } from '../../types/job.js';

// Type pins. `Assert<T extends true>` rejects `false` at tsc time (TS2344).
// Direction matters for `Job`: the wire `payload` is `unknown`, so the server
// shape must satisfy the wire schema, not the reverse.
type Assert<T extends true> = T;
type JobWire = v.InferOutput<typeof JobSchema>;
type JobsResponseWire = v.InferOutput<typeof JobsResponseSchema>;
type JobStatsWire = v.InferOutput<typeof JobStatsSchema>;

export type _JobSatisfiesWire = Assert<Job extends JobWire ? true : false>;
export type _JobStatsToWire = Assert<JobStats extends JobStatsWire ? true : false>;
export type _JobStatsFromWire = Assert<JobStatsWire extends JobStats ? true : false>;
export type _JobsResponseToWire = Assert<JobsResponse extends JobsResponseWire ? true : false>;
// No reverse pin for Job / JobsResponse: the wire payload is `unknown`, so the wire shape is
// intentionally wider than the server's typed payload union.

const jobFixture = {
  id: 'job-1',
  type: 'cleanup:session-outputs',
  payload: { sessionId: 's1' },
  status: 'pending',
  priority: 0,
  attempts: 0,
  maxAttempts: 3,
  nextRetryAt: 1700000000000,
  lastError: null,
  createdAt: 1700000000000,
  startedAt: null,
  completedAt: null,
};

describe('JobSchema', () => {
  it('parses a toJobResponse-shaped fixture', () => {
    expect(v.safeParse(JobSchema, jobFixture).success).toBe(true);
  });

  it('accepts a { _parseError, raw } payload', () => {
    const result = v.safeParse(JobSchema, { ...jobFixture, payload: { _parseError: true, raw: '{bad' } });
    expect(result.success).toBe(true);
  });

  it('accepts lastError null and a string, and set startedAt/completedAt', () => {
    expect(v.safeParse(JobSchema, { ...jobFixture, lastError: null }).success).toBe(true);
    expect(
      v.safeParse(JobSchema, {
        ...jobFixture,
        status: 'completed',
        lastError: 'boom',
        startedAt: 1,
        completedAt: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(v.safeParse(JobSchema, { ...jobFixture, status: 'expired' }).success).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(v.safeParse(JobSchema, { ...jobFixture, type: 'nope' }).success).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(v.safeParse(JobSchema, { ...jobFixture, extra: 1 }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    const { id: _id, ...rest } = jobFixture;
    expect(v.safeParse(JobSchema, rest).success).toBe(false);
  });
});

describe('JobsResponseSchema', () => {
  it('parses a list with total', () => {
    expect(v.safeParse(JobsResponseSchema, { jobs: [jobFixture], total: 1 }).success).toBe(true);
    expect(v.safeParse(JobsResponseSchema, { jobs: [], total: 0 }).success).toBe(true);
  });

  it('rejects a negative total', () => {
    expect(v.safeParse(JobsResponseSchema, { jobs: [], total: -1 }).success).toBe(false);
  });

  it('rejects a non-integer total', () => {
    expect(v.safeParse(JobsResponseSchema, { jobs: [], total: 1.5 }).success).toBe(false);
  });

  it('rejects an extra envelope key', () => {
    expect(v.safeParse(JobsResponseSchema, { jobs: [], total: 0, extra: true }).success).toBe(false);
  });
});

describe('JobStatsSchema', () => {
  const stats = { pending: 1, processing: 0, completed: 5, stalled: 0 };

  it('parses stats counts', () => {
    expect(v.safeParse(JobStatsSchema, stats).success).toBe(true);
  });

  it('rejects a negative or fractional count', () => {
    expect(v.safeParse(JobStatsSchema, { ...stats, pending: -1 }).success).toBe(false);
    expect(v.safeParse(JobStatsSchema, { ...stats, stalled: 0.5 }).success).toBe(false);
  });

  it('rejects a missing key and an extra key', () => {
    const { stalled: _s, ...rest } = stats;
    expect(v.safeParse(JobStatsSchema, rest).success).toBe(false);
    expect(v.safeParse(JobStatsSchema, { ...stats, extra: 1 }).success).toBe(false);
  });
});
