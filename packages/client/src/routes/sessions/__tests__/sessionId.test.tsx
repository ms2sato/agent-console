import { describe, it, expect } from 'bun:test';

/**
 * Tests for session page tab behavior logic.
 * These test the core business rules without rendering the full component.
 */

// Extracted logic from $sessionId.tsx
type WorkerType = 'agent' | 'terminal' | 'git-diff';

/**
 * Determines if a tab can be closed based on worker type.
 * Agent and git-diff tabs are fixed and cannot be closed.
 */
function canCloseTab(workerType: WorkerType): boolean {
  return workerType === 'terminal';
}

/**
 * Determines which worker types should be auto-created when session starts.
 * Both agent and git-diff workers are created automatically.
 */
function getAutoCreateWorkerTypes(): WorkerType[] {
  return ['agent', 'git-diff'];
}

describe('Session page tab behavior', () => {
  describe('canCloseTab', () => {
    it('should return false for agent tabs', () => {
      expect(canCloseTab('agent')).toBe(false);
    });

    it('should return false for git-diff tabs', () => {
      expect(canCloseTab('git-diff')).toBe(false);
    });

    it('should return true for terminal tabs', () => {
      expect(canCloseTab('terminal')).toBe(true);
    });
  });

  describe('getAutoCreateWorkerTypes', () => {
    it('should include agent worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).toContain('agent');
    });

    it('should include git-diff worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).toContain('git-diff');
    });

    it('should not include terminal worker', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types).not.toContain('terminal');
    });

    it('should have exactly 2 worker types', () => {
      const types = getAutoCreateWorkerTypes();
      expect(types.length).toBe(2);
    });
  });
});
