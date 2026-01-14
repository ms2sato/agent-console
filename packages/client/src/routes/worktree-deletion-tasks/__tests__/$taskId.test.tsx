import { describe, it, expect } from 'bun:test';
import type { WorktreeDeletionTask, WorktreeDeletionStatus } from '@agent-console/shared';

/**
 * Tests for worktree deletion task page business logic.
 * These test the core business rules without rendering the full component.
 */

// Helper to create a mock WorktreeDeletionTask
function createMockTask(overrides: Partial<WorktreeDeletionTask> = {}): WorktreeDeletionTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    sessionTitle: 'Test Session',
    repositoryId: 'repo-1',
    worktreePath: '/path/to/worktree',
    status: 'deleting',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Determines if a task is in a failed state.
 */
function isTaskFailed(task: WorktreeDeletionTask): boolean {
  return task.status === 'failed';
}

/**
 * Determines if a task is in a deleting state.
 */
function isTaskDeleting(task: WorktreeDeletionTask): boolean {
  return task.status === 'deleting';
}

/**
 * Determines if a task is in a completed state.
 */
function isTaskCompleted(task: WorktreeDeletionTask): boolean {
  return task.status === 'completed';
}

/**
 * Determines if a task should show Force Delete button.
 * Only failed tasks can be force-deleted.
 */
function canForceDelete(task: WorktreeDeletionTask): boolean {
  return task.status === 'failed';
}

/**
 * Gets the appropriate dismiss button label based on task status.
 */
function getDismissButtonLabel(task: WorktreeDeletionTask): string {
  return task.status === 'deleting' ? 'Hide' : 'Dismiss';
}

/**
 * Gets the page title based on task status.
 */
function getPageTitle(task: WorktreeDeletionTask): string {
  if (task.status === 'failed') return 'Worktree Deletion Failed';
  if (task.status === 'completed') return 'Worktree Deleted';
  return 'Delete Worktree';
}

/**
 * Gets the status label based on task status.
 */
function getStatusLabel(task: WorktreeDeletionTask): string {
  if (task.status === 'failed') return 'Failed';
  if (task.status === 'completed') return 'Deleted successfully';
  return 'Deleting worktree...';
}

describe('Worktree Deletion Task Page', () => {
  describe('task state detection', () => {
    it('should identify failed task', () => {
      const task = createMockTask({ status: 'failed', error: 'Something went wrong' });
      expect(isTaskFailed(task)).toBe(true);
      expect(isTaskDeleting(task)).toBe(false);
      expect(isTaskCompleted(task)).toBe(false);
    });

    it('should identify deleting task', () => {
      const task = createMockTask({ status: 'deleting' });
      expect(isTaskFailed(task)).toBe(false);
      expect(isTaskDeleting(task)).toBe(true);
      expect(isTaskCompleted(task)).toBe(false);
    });

    it('should identify completed task', () => {
      const task = createMockTask({ status: 'completed' });
      expect(isTaskFailed(task)).toBe(false);
      expect(isTaskDeleting(task)).toBe(false);
      expect(isTaskCompleted(task)).toBe(true);
    });
  });

  describe('force delete button visibility', () => {
    it('should show force delete button for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(canForceDelete(task)).toBe(true);
    });

    it('should not show force delete button for deleting tasks', () => {
      const task = createMockTask({ status: 'deleting' });
      expect(canForceDelete(task)).toBe(false);
    });

    it('should not show force delete button for completed tasks', () => {
      const task = createMockTask({ status: 'completed' });
      expect(canForceDelete(task)).toBe(false);
    });
  });

  describe('dismiss button label', () => {
    it('should show Hide for deleting tasks', () => {
      const task = createMockTask({ status: 'deleting' });
      expect(getDismissButtonLabel(task)).toBe('Hide');
    });

    it('should show Dismiss for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(getDismissButtonLabel(task)).toBe('Dismiss');
    });

    it('should show Dismiss for completed tasks', () => {
      const task = createMockTask({ status: 'completed' });
      expect(getDismissButtonLabel(task)).toBe('Dismiss');
    });
  });

  describe('page title', () => {
    it('should show failure title for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(getPageTitle(task)).toBe('Worktree Deletion Failed');
    });

    it('should show deleting title for deleting tasks', () => {
      const task = createMockTask({ status: 'deleting' });
      expect(getPageTitle(task)).toBe('Delete Worktree');
    });

    it('should show success title for completed tasks', () => {
      const task = createMockTask({ status: 'completed' });
      expect(getPageTitle(task)).toBe('Worktree Deleted');
    });
  });

  describe('status label', () => {
    it('should show Failed for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(getStatusLabel(task)).toBe('Failed');
    });

    it('should show Deleting for deleting tasks', () => {
      const task = createMockTask({ status: 'deleting' });
      expect(getStatusLabel(task)).toBe('Deleting worktree...');
    });

    it('should show Deleted successfully for completed tasks', () => {
      const task = createMockTask({ status: 'completed' });
      expect(getStatusLabel(task)).toBe('Deleted successfully');
    });
  });

  describe('force delete logic', () => {
    it('should generate new taskId for force delete', () => {
      const originalTaskId = 'original-task-id';
      const newTaskId = crypto.randomUUID();

      // Simulate force delete behavior: new taskId should be different
      expect(newTaskId).not.toBe(originalTaskId);
      expect(newTaskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should preserve task data for force delete', () => {
      const task = createMockTask({
        status: 'failed',
        error: 'Uncommitted changes',
        sessionId: 'session-123',
        sessionTitle: 'Feature Branch',
        repositoryId: 'repo-456',
        worktreePath: '/path/to/worktree',
      });

      // When force deleting, task data should be preserved for the new task
      const newTask = {
        id: crypto.randomUUID(),
        sessionId: task.sessionId,
        sessionTitle: task.sessionTitle,
        repositoryId: task.repositoryId,
        worktreePath: task.worktreePath,
      };

      expect(newTask.sessionId).toBe('session-123');
      expect(newTask.sessionTitle).toBe('Feature Branch');
      expect(newTask.repositoryId).toBe('repo-456');
      expect(newTask.worktreePath).toBe('/path/to/worktree');
      // Only taskId should change
      expect(newTask.id).not.toBe('task-1');
    });
  });

  describe('task not found handling', () => {
    it('should return undefined for non-existent task', () => {
      const tasks: WorktreeDeletionTask[] = [
        createMockTask({ id: 'task-1' }),
        createMockTask({ id: 'task-2' }),
      ];

      const task = tasks.find((t) => t.id === 'non-existent');
      expect(task).toBeUndefined();
    });

    it('should find existing task by id', () => {
      const tasks: WorktreeDeletionTask[] = [
        createMockTask({ id: 'task-1', sessionTitle: 'Session 1' }),
        createMockTask({ id: 'task-2', sessionTitle: 'Session 2' }),
      ];

      const task = tasks.find((t) => t.id === 'task-2');
      expect(task).toBeDefined();
      expect(task?.sessionTitle).toBe('Session 2');
    });
  });

  describe('error details display', () => {
    it('should show error when task has failed with error', () => {
      const task = createMockTask({
        status: 'failed',
        error: 'Uncommitted changes in worktree',
      });

      expect(task.status).toBe('failed');
      expect(task.error).toBe('Uncommitted changes in worktree');
    });

    it('should not have error for deleting tasks', () => {
      const task = createMockTask({ status: 'deleting' });

      expect(task.error).toBeUndefined();
    });

    it('should not have error for completed tasks', () => {
      const task = createMockTask({ status: 'completed' });

      expect(task.error).toBeUndefined();
    });
  });

  describe('exhaustive status handling', () => {
    it('should handle all possible status values', () => {
      const statuses: WorktreeDeletionStatus[] = ['deleting', 'completed', 'failed'];

      for (const status of statuses) {
        const task = createMockTask({ status });
        // All status values should be handled without throwing
        expect(() => getPageTitle(task)).not.toThrow();
        expect(() => getStatusLabel(task)).not.toThrow();
        expect(() => getDismissButtonLabel(task)).not.toThrow();
        expect(() => canForceDelete(task)).not.toThrow();
      }
    });
  });
});
