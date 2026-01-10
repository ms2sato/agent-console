import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useWorktreeCreationTasks } from '../useWorktreeCreationTasks';
import type {
  CreateWorktreeRequest,
  WorktreeCreationCompletedPayload,
  WorktreeCreationFailedPayload,
} from '@agent-console/shared';

// Helper to create a mock CreateWorktreeRequest
function createMockRequest(overrides: Partial<CreateWorktreeRequest> = {}): CreateWorktreeRequest {
  return {
    mode: 'prompt',
    initialPrompt: 'Test prompt',
    taskId: 'test-task-id',
    ...overrides,
  } as CreateWorktreeRequest;
}

describe('useWorktreeCreationTasks', () => {
  describe('addTask', () => {
    it('should create task with creating status', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe('task-1');
      expect(result.current.tasks[0].status).toBe('creating');
      expect(result.current.tasks[0].repositoryId).toBe('repo-1');
      expect(result.current.tasks[0].repositoryName).toBe('My Repository');
    });

    it('should add multiple tasks', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'Repo 1',
          request: createMockRequest(),
        });
      });

      act(() => {
        result.current.addTask({
          id: 'task-2',
          repositoryId: 'repo-2',
          repositoryName: 'Repo 2',
          request: createMockRequest(),
        });
      });

      expect(result.current.tasks).toHaveLength(2);
      expect(result.current.tasks[0].id).toBe('task-1');
      expect(result.current.tasks[1].id).toBe('task-2');
    });

    it('should include createdAt timestamp', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      const beforeTime = new Date().toISOString();

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      const afterTime = new Date().toISOString();

      expect(result.current.tasks[0].createdAt).toBeDefined();
      expect(result.current.tasks[0].createdAt >= beforeTime).toBe(true);
      expect(result.current.tasks[0].createdAt <= afterTime).toBe(true);
    });
  });

  describe('handleWorktreeCreationCompleted', () => {
    it('should update task to completed status with sessionId and sessionTitle', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      const payload: WorktreeCreationCompletedPayload = {
        taskId: 'task-1',
        worktree: {
          path: '/test/path',
          branch: 'feature/test',
          isMain: false,
          repositoryId: 'repo-1',
        },
        session: {
          id: 'session-1',
          type: 'worktree',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          worktreeId: 'wt-1',
          locationPath: '/test/path',
          status: 'active',
          createdAt: new Date().toISOString(),
          workers: [],
          title: 'Test Session Title',
        },
      };

      act(() => {
        result.current.handleWorktreeCreationCompleted(payload);
      });

      expect(result.current.tasks[0].status).toBe('completed');
      expect(result.current.tasks[0].sessionId).toBe('session-1');
      expect(result.current.tasks[0].sessionTitle).toBe('Test Session Title');
    });

    it('should handle completion with null session', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      const payload: WorktreeCreationCompletedPayload = {
        taskId: 'task-1',
        worktree: {
          path: '/test/path',
          branch: 'feature/test',
          isMain: false,
          repositoryId: 'repo-1',
        },
        session: null,
      };

      act(() => {
        result.current.handleWorktreeCreationCompleted(payload);
      });

      expect(result.current.tasks[0].status).toBe('completed');
      expect(result.current.tasks[0].sessionId).toBeUndefined();
      expect(result.current.tasks[0].sessionTitle).toBeUndefined();
    });

    it('should only update the matching task', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'Repo 1',
          request: createMockRequest(),
        });
        result.current.addTask({
          id: 'task-2',
          repositoryId: 'repo-2',
          repositoryName: 'Repo 2',
          request: createMockRequest(),
        });
      });

      const payload: WorktreeCreationCompletedPayload = {
        taskId: 'task-1',
        worktree: {
          path: '/test/path',
          branch: 'feature/test',
          isMain: false,
          repositoryId: 'repo-1',
        },
        session: {
          id: 'session-1',
          type: 'worktree',
          repositoryId: 'repo-1',
          repositoryName: 'Repo 1',
          worktreeId: 'wt-1',
          locationPath: '/test/path',
          status: 'active',
          createdAt: new Date().toISOString(),
          workers: [],
        },
      };

      act(() => {
        result.current.handleWorktreeCreationCompleted(payload);
      });

      expect(result.current.tasks[0].status).toBe('completed');
      expect(result.current.tasks[1].status).toBe('creating');
    });
  });

  describe('handleWorktreeCreationFailed', () => {
    it('should update task to failed status with error', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      const payload: WorktreeCreationFailedPayload = {
        taskId: 'task-1',
        error: 'Branch already exists',
      };

      act(() => {
        result.current.handleWorktreeCreationFailed(payload);
      });

      expect(result.current.tasks[0].status).toBe('failed');
      expect(result.current.tasks[0].error).toBe('Branch already exists');
    });

    it('should only update the matching task', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'Repo 1',
          request: createMockRequest(),
        });
        result.current.addTask({
          id: 'task-2',
          repositoryId: 'repo-2',
          repositoryName: 'Repo 2',
          request: createMockRequest(),
        });
      });

      const payload: WorktreeCreationFailedPayload = {
        taskId: 'task-2',
        error: 'Failed to create worktree',
      };

      act(() => {
        result.current.handleWorktreeCreationFailed(payload);
      });

      expect(result.current.tasks[0].status).toBe('creating');
      expect(result.current.tasks[1].status).toBe('failed');
      expect(result.current.tasks[1].error).toBe('Failed to create worktree');
    });
  });

  describe('removeTask', () => {
    it('should remove task from list', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'Repo 1',
          request: createMockRequest(),
        });
        result.current.addTask({
          id: 'task-2',
          repositoryId: 'repo-2',
          repositoryName: 'Repo 2',
          request: createMockRequest(),
        });
      });

      expect(result.current.tasks).toHaveLength(2);

      act(() => {
        result.current.removeTask('task-1');
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe('task-2');
    });

    it('should do nothing if task does not exist', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      act(() => {
        result.current.removeTask('non-existent-task');
      });

      expect(result.current.tasks).toHaveLength(1);
    });
  });

  describe('getTask', () => {
    it('should retrieve task by ID', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      const task = result.current.getTask('task-1');

      expect(task).toBeDefined();
      expect(task?.id).toBe('task-1');
      expect(task?.repositoryName).toBe('My Repository');
    });

    it('should return undefined for non-existent task', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      const task = result.current.getTask('non-existent-task');

      expect(task).toBeUndefined();
    });

    it('should return undefined after task is removed', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      act(() => {
        result.current.removeTask('task-1');
      });

      const task = result.current.getTask('task-1');
      expect(task).toBeUndefined();
    });
  });

  describe('task state transitions', () => {
    it('should transition from creating to completed', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      expect(result.current.tasks[0].status).toBe('creating');

      act(() => {
        result.current.handleWorktreeCreationCompleted({
          taskId: 'task-1',
          worktree: {
            path: '/test/path',
            branch: 'feature/test',
            isMain: false,
            repositoryId: 'repo-1',
          },
          session: {
            id: 'session-1',
            type: 'worktree',
            repositoryId: 'repo-1',
            repositoryName: 'My Repository',
            worktreeId: 'wt-1',
            locationPath: '/test/path',
            status: 'active',
            createdAt: new Date().toISOString(),
            workers: [],
          },
        });
      });

      expect(result.current.tasks[0].status).toBe('completed');
    });

    it('should transition from creating to failed', () => {
      const { result } = renderHook(() => useWorktreeCreationTasks());

      act(() => {
        result.current.addTask({
          id: 'task-1',
          repositoryId: 'repo-1',
          repositoryName: 'My Repository',
          request: createMockRequest(),
        });
      });

      expect(result.current.tasks[0].status).toBe('creating');

      act(() => {
        result.current.handleWorktreeCreationFailed({
          taskId: 'task-1',
          error: 'Something went wrong',
        });
      });

      expect(result.current.tasks[0].status).toBe('failed');
      expect(result.current.tasks[0].error).toBe('Something went wrong');
    });
  });
});
