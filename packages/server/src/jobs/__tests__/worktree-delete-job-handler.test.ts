import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { JOB_TYPES } from '@agent-console/shared';
import type { AppServerMessage, WorktreeDeletePayload } from '@agent-console/shared';
import type { JobQueue, JobHandler } from '../job-queue.js';
import { registerWorktreeDeleteJobHandler } from '../worktree-delete-job-handler.js';
import type { DeleteWorktreeDeps, DeleteWorktreeFn } from '../../services/worktree-deletion-service.js';

/**
 * `JobQueue` has private fields, so a stub object literal cannot satisfy it
 * structurally. `Partial<JobQueue>` retains the same private brand, so this
 * single-step cast type-checks without bridging through `unknown`.
 */
function asJobQueue(stub: Partial<JobQueue>): JobQueue {
  return stub as JobQueue;
}

describe('worktree:delete handler (Issue #1327)', () => {
  let handlers: Map<string, JobHandler<unknown>>;
  let fakeQueue: JobQueue;
  let broadcasts: AppServerMessage[];

  // `deleteWorktreeImpl` is always mocked in this describe block, so
  // `deletionDeps` is never actually dereferenced -- it only needs to
  // type-check as a pass-through value the handler forwards unchanged.
  const deletionDeps = {} as DeleteWorktreeDeps;

  const payload: WorktreeDeletePayload = {
    jobId: 'job-1',
    repoId: 'repo-1',
    worktreePath: '/repo/worktrees/wt-1',
    force: false,
    requestUsername: 'alice',
  };

  beforeEach(() => {
    handlers = new Map();
    broadcasts = [];
    fakeQueue = asJobQueue({
      registerHandler: <T>(type: string, handler: JobHandler<T>) => {
        handlers.set(type, handler as JobHandler<unknown>);
      },
    });
  });

  function registerWithImpl(deleteWorktreeImpl: DeleteWorktreeFn): JobHandler<unknown> {
    registerWorktreeDeleteJobHandler(fakeQueue, {
      deletionDeps,
      broadcastToApp: (msg) => broadcasts.push(msg),
      deleteWorktreeImpl,
    });
    return handlers.get(JOB_TYPES.WORKTREE_DELETE)!;
  }

  it('success: forwards payload params + deletionDeps to deleteWorktreeImpl, broadcasts worktree-deletion-completed, resolves', async () => {
    const deleteWorktreeImplMock = mock<DeleteWorktreeFn>(async () => ({
      success: true,
      sessionIds: ['s1'],
      cleanupCommandResult: { success: true, output: 'ok' },
      killErrors: [{ sessionId: 's1', error: 'kill failed' }],
    }));
    const deleteWorktreeImpl: DeleteWorktreeFn = deleteWorktreeImplMock;

    const handler = registerWithImpl(deleteWorktreeImpl);

    await expect(handler(payload)).resolves.toBeUndefined();

    expect(deleteWorktreeImpl).toHaveBeenCalledTimes(1);
    const call = deleteWorktreeImplMock.mock.calls[0];
    expect(call[0]).toEqual({
      repoId: 'repo-1',
      worktreePath: '/repo/worktrees/wt-1',
      force: false,
      requestUsername: 'alice',
    });
    expect(call[1]).toBe(deletionDeps);

    expect(broadcasts).toEqual([
      {
        type: 'worktree-deletion-completed',
        taskId: 'job-1',
        sessionIds: ['s1'],
        cleanupCommandResult: { success: true, output: 'ok' },
        killErrors: [{ sessionId: 's1', error: 'kill failed' }],
      },
    ]);
  });

  it('result failure: broadcasts worktree-deletion-failed with the error/gitStatus and rejects', async () => {
    const deleteWorktreeImpl: DeleteWorktreeFn = mock(async () => ({
      success: false,
      error: 'Failed to remove worktree: dirty working tree',
      gitStatus: 'M some-file.ts',
      sessionIds: ['s2'],
    }));

    const handler = registerWithImpl(deleteWorktreeImpl);

    await expect(handler(payload)).rejects.toThrow('Failed to remove worktree: dirty working tree');

    expect(broadcasts).toEqual([
      {
        type: 'worktree-deletion-failed',
        taskId: 'job-1',
        sessionIds: ['s2'],
        error: 'Failed to remove worktree: dirty working tree',
        gitStatus: 'M some-file.ts',
      },
    ]);
  });

  it('thrown exception: broadcasts worktree-deletion-failed with sessionIds: [] and rethrows', async () => {
    const deleteWorktreeImpl: DeleteWorktreeFn = mock(async () => {
      throw new Error('unexpected filesystem error');
    });

    const handler = registerWithImpl(deleteWorktreeImpl);

    await expect(handler(payload)).rejects.toThrow('unexpected filesystem error');

    expect(broadcasts).toEqual([
      {
        type: 'worktree-deletion-failed',
        taskId: 'job-1',
        sessionIds: [],
        error: 'unexpected filesystem error',
      },
    ]);
  });
});
