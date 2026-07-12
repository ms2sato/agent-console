import { describe, it, expect } from 'bun:test';
import type { Session, EmbeddedAgentWorker, TerminalWorker } from '@agent-console/shared';
import { findReferencingWorkers } from '../findReferencingWorkers';

function makeEmbeddedWorker(id: string, embeddedAgentId: string): EmbeddedAgentWorker {
  return {
    id,
    name: `worker-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'embedded-agent',
    embeddedAgentId,
    activated: true,
  };
}

function makeTerminalWorker(id: string): TerminalWorker {
  return {
    id,
    name: `terminal-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'terminal',
    activated: true,
  };
}

function makeSession(id: string, workers: Session['workers']): Session {
  return {
    id,
    type: 'quick',
    locationPath: `/tmp/${id}`,
    status: 'active',
    activationState: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers,
    isShared: false,
    recoveryState: 'healthy',
  };
}

describe('findReferencingWorkers', () => {
  it('returns an empty array when there are no sessions', () => {
    expect(findReferencingWorkers([], 'embedded-1')).toEqual([]);
  });

  it('returns an empty array when sessions exist but none reference the id', () => {
    const sessions = [
      makeSession('s1', [makeEmbeddedWorker('w1', 'embedded-other'), makeTerminalWorker('w2')]),
      makeSession('s2', [makeTerminalWorker('w3')]),
    ];

    expect(findReferencingWorkers(sessions, 'embedded-1')).toEqual([]);
  });

  it('returns all references across multiple sessions and workers', () => {
    const worker1 = makeEmbeddedWorker('w1', 'embedded-1');
    const worker2 = makeEmbeddedWorker('w2', 'embedded-1');
    const session1 = makeSession('s1', [worker1]);
    const session2 = makeSession('s2', [worker2, makeTerminalWorker('w3')]);

    const result = findReferencingWorkers([session1, session2], 'embedded-1');

    expect(result).toEqual([
      { session: session1, worker: worker1 },
      { session: session2, worker: worker2 },
    ]);
  });

  it('only returns embedded-agent workers matching the given id, ignoring workers for other ids', () => {
    const matching = makeEmbeddedWorker('w1', 'embedded-1');
    const other = makeEmbeddedWorker('w2', 'embedded-2');
    const session = makeSession('s1', [matching, other, makeTerminalWorker('w3')]);

    const result = findReferencingWorkers([session], 'embedded-1');

    expect(result).toEqual([{ session, worker: matching }]);
  });
});
