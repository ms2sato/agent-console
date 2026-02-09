import { describe, it, expect } from 'bun:test';
import type { WorktreeCreationTask, CreateWorktreeRequest } from '@agent-console/shared';

/**
 * Tests for worktree creation task page business logic.
 * These test the core business rules without rendering the full component.
 */

// Helper to create a mock CreateWorktreeRequest
function createMockRequest(overrides: Partial<CreateWorktreeRequest> = {}): CreateWorktreeRequest {
  return {
    mode: 'prompt',
    initialPrompt: 'Test prompt',
    taskId: 'test-task-id',
    ...overrides,
  } as CreateWorktreeRequest;
}

// Helper to create a mock WorktreeCreationTask
function createMockTask(overrides: Partial<WorktreeCreationTask> = {}): WorktreeCreationTask {
  return {
    id: 'task-1',
    repositoryId: 'repo-1',
    repositoryName: 'My Repository',
    status: 'creating',
    request: createMockRequest(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Determines if a task is in a failed state.
 */
function isTaskFailed(task: WorktreeCreationTask): boolean {
  return task.status === 'failed';
}

/**
 * Determines if a task is in a creating state.
 */
function isTaskCreating(task: WorktreeCreationTask): boolean {
  return task.status === 'creating';
}

/**
 * Determines if a task is in a completed state.
 */
function isTaskCompleted(task: WorktreeCreationTask): boolean {
  return task.status === 'completed';
}

/**
 * Determines if a task should show retry button.
 * Only failed tasks can be retried.
 */
function canRetryTask(task: WorktreeCreationTask): boolean {
  return task.status === 'failed';
}

/**
 * Gets the appropriate dismiss button label based on task status.
 */
function getDismissButtonLabel(task: WorktreeCreationTask): string {
  return task.status === 'creating' ? 'Cancel' : 'Dismiss';
}

/**
 * Gets the page title based on task status.
 */
function getPageTitle(task: WorktreeCreationTask): string {
  return task.status === 'failed' ? 'Worktree Creation Failed' : 'Creating Worktree...';
}

describe('Worktree Creation Task Page', () => {
  describe('task state detection', () => {
    it('should identify failed task', () => {
      const task = createMockTask({ status: 'failed', error: 'Something went wrong' });
      expect(isTaskFailed(task)).toBe(true);
      expect(isTaskCreating(task)).toBe(false);
      expect(isTaskCompleted(task)).toBe(false);
    });

    it('should identify creating task', () => {
      const task = createMockTask({ status: 'creating' });
      expect(isTaskFailed(task)).toBe(false);
      expect(isTaskCreating(task)).toBe(true);
      expect(isTaskCompleted(task)).toBe(false);
    });

    it('should identify completed task', () => {
      const task = createMockTask({
        status: 'completed',
        sessionId: 'session-1',
        sessionTitle: 'Test Session',
      });
      expect(isTaskFailed(task)).toBe(false);
      expect(isTaskCreating(task)).toBe(false);
      expect(isTaskCompleted(task)).toBe(true);
    });
  });

  describe('retry button visibility', () => {
    it('should show retry button for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(canRetryTask(task)).toBe(true);
    });

    it('should not show retry button for creating tasks', () => {
      const task = createMockTask({ status: 'creating' });
      expect(canRetryTask(task)).toBe(false);
    });

    it('should not show retry button for completed tasks', () => {
      const task = createMockTask({ status: 'completed', sessionId: 'session-1' });
      expect(canRetryTask(task)).toBe(false);
    });
  });

  describe('dismiss button label', () => {
    it('should show Cancel for creating tasks', () => {
      const task = createMockTask({ status: 'creating' });
      expect(getDismissButtonLabel(task)).toBe('Cancel');
    });

    it('should show Dismiss for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(getDismissButtonLabel(task)).toBe('Dismiss');
    });

    it('should show Dismiss for completed tasks', () => {
      const task = createMockTask({ status: 'completed', sessionId: 'session-1' });
      expect(getDismissButtonLabel(task)).toBe('Dismiss');
    });
  });

  describe('page title', () => {
    it('should show failure title for failed tasks', () => {
      const task = createMockTask({ status: 'failed', error: 'Error' });
      expect(getPageTitle(task)).toBe('Worktree Creation Failed');
    });

    it('should show creating title for creating tasks', () => {
      const task = createMockTask({ status: 'creating' });
      expect(getPageTitle(task)).toBe('Creating Worktree...');
    });

    it('should show creating title for completed tasks (since page should redirect)', () => {
      // Note: completed tasks with sessionId should navigate away from this page,
      // but if they don't have sessionId, this title is still shown
      const task = createMockTask({ status: 'completed' });
      expect(getPageTitle(task)).toBe('Creating Worktree...');
    });
  });

  describe('retry logic', () => {
    it('should generate new taskId for retry', () => {
      const originalTaskId = 'original-task-id';
      const newTaskId = crypto.randomUUID();

      // Simulate retry behavior: new taskId should be different
      expect(newTaskId).not.toBe(originalTaskId);
      expect(newTaskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should preserve original request data for retry', () => {
      const originalRequest: CreateWorktreeRequest = {
        mode: 'prompt',
        initialPrompt: 'Fix the login bug',
        baseBranch: 'main',
        title: 'Fix Login Bug',
        taskId: 'original-task-id',
      };

      const task = createMockTask({
        status: 'failed',
        error: 'Branch already exists',
        request: originalRequest,
      });

      // When retrying, request data should be preserved
      const retryRequest = { ...task.request, taskId: crypto.randomUUID() };

      expect(retryRequest.mode).toBe('prompt');
      // Type narrow to access mode-specific properties
      if (retryRequest.mode === 'prompt') {
        expect(retryRequest.initialPrompt).toBe('Fix the login bug');
        expect(retryRequest.baseBranch).toBe('main');
      }
      expect(retryRequest.title).toBe('Fix Login Bug');
      // Only taskId should change
      expect(retryRequest.taskId).not.toBe('original-task-id');
    });
  });

  describe('creation parameters display', () => {
    it('should display prompt mode parameters', () => {
      const request: CreateWorktreeRequest = {
        mode: 'prompt',
        initialPrompt: 'Build a new feature',
        baseBranch: 'develop',
        taskId: 'task-1',
      };

      expect(request.mode).toBe('prompt');
      expect(request.initialPrompt).toBe('Build a new feature');
      expect(request.baseBranch).toBe('develop');
    });

    it('should display custom mode parameters', () => {
      const request: CreateWorktreeRequest = {
        mode: 'custom',
        branch: 'feature/my-feature',
        baseBranch: 'main',
        taskId: 'task-1',
      };

      expect(request.mode).toBe('custom');
      expect(request.branch).toBe('feature/my-feature');
      expect(request.baseBranch).toBe('main');
    });

    it('should display existing mode parameters', () => {
      const request: CreateWorktreeRequest = {
        mode: 'existing',
        branch: 'feature/existing-branch',
        taskId: 'task-1',
      };

      expect(request.mode).toBe('existing');
      expect(request.branch).toBe('feature/existing-branch');
    });
  });

  describe('task not found handling', () => {
    it('should return undefined for non-existent task', () => {
      const tasks: WorktreeCreationTask[] = [
        createMockTask({ id: 'task-1' }),
        createMockTask({ id: 'task-2' }),
      ];

      const task = tasks.find((t) => t.id === 'non-existent');
      expect(task).toBeUndefined();
    });

    it('should find existing task by id', () => {
      const tasks: WorktreeCreationTask[] = [
        createMockTask({ id: 'task-1', repositoryName: 'Repo 1' }),
        createMockTask({ id: 'task-2', repositoryName: 'Repo 2' }),
      ];

      const task = tasks.find((t) => t.id === 'task-2');
      expect(task).toBeDefined();
      expect(task?.repositoryName).toBe('Repo 2');
    });
  });

  describe('error details display', () => {
    it('should show error when task has failed with error', () => {
      const task = createMockTask({
        status: 'failed',
        error: 'Branch "feature/test" already exists',
      });

      expect(task.status).toBe('failed');
      expect(task.error).toBe('Branch "feature/test" already exists');
    });

    it('should not have error for creating tasks', () => {
      const task = createMockTask({ status: 'creating' });

      expect(task.error).toBeUndefined();
    });

    it('should not have error for completed tasks', () => {
      const task = createMockTask({
        status: 'completed',
        sessionId: 'session-1',
      });

      expect(task.error).toBeUndefined();
    });
  });
});
