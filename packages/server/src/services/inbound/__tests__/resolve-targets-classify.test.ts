import { describe, it, expect } from 'bun:test';
import type { WorktreeSession } from '@agent-console/shared';
import { classifyOrchestratorSession } from '../resolve-targets.js';
import { buildWorktreeSession } from '../../../__tests__/utils/build-test-data.js';

const AGENT_WORKER = {
  id: 'worker-1',
  type: 'agent' as const,
  name: 'Claude',
  agentId: 'claude-code-builtin',
  activated: true,
  createdAt: '2024-01-01T00:00:00Z',
};
const DIFF_WORKER = {
  id: 'worker-diff',
  type: 'git-diff' as const,
  name: 'Diff',
  createdAt: '2024-01-01T00:00:00Z',
  baseCommit: 'abc123',
};

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return buildWorktreeSession({ id: 'orch-1', workers: [AGENT_WORKER], ...overrides });
}

describe('classifyOrchestratorSession', () => {
  it('reports a session that is not among the routable sessions as not-live', () => {
    expect(classifyOrchestratorSession('ghost', [session()], new Set())).toEqual({ eligible: false, reason: 'not-live' });
  });

  it('reports not-live for an empty session list', () => {
    expect(classifyOrchestratorSession('orch-1', [], new Set())).toEqual({ eligible: false, reason: 'not-live' });
  });

  it('reports a hibernated, non-paused session as not-running', () => {
    const hibernated = session({ activationState: 'hibernated' });
    expect(classifyOrchestratorSession('orch-1', [hibernated], new Set())).toEqual({
      eligible: false,
      reason: 'not-running',
    });
  });

  it('reports a running session with no agent-shaped worker as no-agent-worker', () => {
    const diffOnly = session({ workers: [DIFF_WORKER] });
    expect(classifyOrchestratorSession('orch-1', [diffOnly], new Set())).toEqual({
      eligible: false,
      reason: 'no-agent-worker',
    });
  });

  it('reports a running session with no workers at all as no-agent-worker', () => {
    expect(classifyOrchestratorSession('orch-1', [session({ workers: [] })], new Set())).toEqual({
      eligible: false,
      reason: 'no-agent-worker',
    });
  });

  it('classifies a live running session with an agent worker as eligible and not paused', () => {
    expect(classifyOrchestratorSession('orch-1', [session()], new Set())).toEqual({ eligible: true, paused: false });
  });

  it('classifies a paused session (hibernated activation state) as eligible and paused', () => {
    const paused = session({ activationState: 'hibernated' });
    expect(classifyOrchestratorSession('orch-1', [paused], new Set(['orch-1']))).toEqual({
      eligible: true,
      paused: true,
    });
  });

  it('checks the running state before the agent worker: not running AND no agent worker reports not-running', () => {
    const both = session({ activationState: 'hibernated', workers: [DIFF_WORKER] });
    expect(classifyOrchestratorSession('orch-1', [both], new Set())).toEqual({ eligible: false, reason: 'not-running' });
  });

  it('still requires an agent worker for a paused session', () => {
    const pausedNoAgent = session({ activationState: 'hibernated', workers: [DIFF_WORKER] });
    expect(classifyOrchestratorSession('orch-1', [pausedNoAgent], new Set(['orch-1']))).toEqual({
      eligible: false,
      reason: 'no-agent-worker',
    });
  });

  it('picks the requested session out of several', () => {
    const other = session({ id: 'other', activationState: 'hibernated' });
    expect(classifyOrchestratorSession('orch-1', [other, session()], new Set())).toEqual({ eligible: true, paused: false });
  });
});
