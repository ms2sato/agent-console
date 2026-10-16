import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  AgentsResponseSchema,
  RepositoriesResponseSchema,
  SessionResponseSchema,
  SessionsValidationResponseSchema,
  ReviewQueueResponseSchema,
} from '@agent-console/shared';
import { completeWireBody } from '../wire-fixtures';

describe('completeWireBody', () => {
  it('turns partial agent, repository and session envelopes into bodies the strict schemas accept', () => {
    expect(
      v.safeParse(AgentsResponseSchema, completeWireBody({ agents: [{ id: 'a', name: 'A' }] })).success,
    ).toBe(true);
    expect(
      v.safeParse(RepositoriesResponseSchema, completeWireBody({ repositories: [{ id: 'r' }] })).success,
    ).toBe(true);
    expect(
      v.safeParse(SessionResponseSchema, completeWireBody({ session: { id: 's', type: 'quick' } })).success,
    ).toBe(true);
    expect(
      v.safeParse(
        SessionResponseSchema,
        completeWireBody({ session: { id: 's', type: 'worktree', worktreeId: 'feat' } }),
      ).success,
    ).toBe(true);
  });

  it('never overrides a field the fixture sets', () => {
    const body = completeWireBody({ agents: [{ id: 'a', name: 'Mine', isBuiltIn: true, createdAt: 'x' }] }) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(body.agents[0]).toMatchObject({ name: 'Mine', isBuiltIn: true, createdAt: 'x' });
  });

  it('returns a body without a recognised envelope key, and an empty list, unchanged', () => {
    expect(completeWireBody({ error: 'boom' })).toEqual({ error: 'boom' });
    expect(completeWireBody({ agents: [] })).toEqual({ agents: [] });
    expect(completeWireBody(null)).toBeNull();
  });

  it('completes a partial session-validation envelope and a bare review-queue array', () => {
    expect(
      v.safeParse(
        SessionsValidationResponseSchema,
        completeWireBody({ hasIssues: true, results: [{ sessionId: 's1', valid: false }] }),
      ).success,
    ).toBe(true);
    expect(
      v.safeParse(
        ReviewQueueResponseSchema,
        completeWireBody([{ sourceSessionId: 's1', sourceSessionTitle: 'S', items: [{ workerId: 'w1' }] }]),
      ).success,
    ).toBe(true);
    expect(completeWireBody([])).toEqual([]);
  });
});
