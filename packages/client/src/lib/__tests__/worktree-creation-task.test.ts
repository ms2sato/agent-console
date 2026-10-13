import { describe, it, expect } from 'bun:test';
import type { CreateWorktreeRequest } from '@agent-console/shared';
import type { WorktreeCreationStatus, WorktreeCreationTask } from '../worktree-creation-task';

// Type-level pins. `Assert<T extends true>` rejects a `false` argument with TS2344, so a
// drift fails `tsc` (a `declare const x: never` form would stay silent under drift).
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type _StatusIsTheThreeStates = Assert<Equals<WorktreeCreationStatus, 'creating' | 'completed' | 'failed'>>;
// The retry flow re-sends the original request, so it must stay the shared wire request type.
export type _RequestIsTheSharedWireType = Assert<Equals<WorktreeCreationTask['request'], CreateWorktreeRequest>>;

describe('WorktreeCreationTask', () => {
  it('carries a completed task with the navigation fields and a failed task with its error', () => {
    const request = { branch: 'feature/x' } as CreateWorktreeRequest;
    const completed: WorktreeCreationTask = {
      id: 't1',
      repositoryId: 'r1',
      repositoryName: 'repo',
      status: 'completed',
      request,
      sessionId: 's1',
      sessionTitle: 'title',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const failed: WorktreeCreationTask = { ...completed, status: 'failed', error: 'boom', sessionId: undefined };

    expect(completed.sessionId).toBe('s1');
    expect(failed.error).toBe('boom');
    expect(failed.request).toBe(request);
  });
});
