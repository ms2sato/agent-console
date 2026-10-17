import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  AgentsResponseSchema,
  RepositoriesResponseSchema,
  SessionResponseSchema,
  WorkerResponseSchema,
  SessionsValidationResponseSchema,
  ReviewQueueResponseSchema,
  EmbeddedAgentsListResponseSchema,
  EmbeddedAgentResponseSchema,
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

  it('completes a partial worker envelope of every worker type', () => {
    for (const type of ['agent', 'terminal', 'git-diff', 'embedded-agent']) {
      expect(v.safeParse(WorkerResponseSchema, completeWireBody({ worker: { id: 'w', type } })).success).toBe(true);
    }
  });

  it('completes a partial embedded-agent list and single envelope, for both engines', () => {
    expect(
      v.safeParse(
        EmbeddedAgentsListResponseSchema,
        completeWireBody({ embeddedAgents: [{ id: 'e1' }, { id: 'e2', engine: 'claude-sdk' }] }),
      ).success,
    ).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentResponseSchema, completeWireBody({ embeddedAgent: { id: 'e1' } })).success,
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
