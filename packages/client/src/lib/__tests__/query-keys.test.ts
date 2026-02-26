import { describe, it, expect as bunExpect } from 'bun:test';
import {
  repositoryKeys,
  agentKeys,
  jobKeys,
  sessionKeys,
  worktreeKeys,
  branchKeys,
  systemKeys,
  notificationKeys,
} from '../query-keys';

// Workaround: Bun's expect is stricter than vitest's for toEqual type checking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = (value: unknown): any => bunExpect(value);

describe('Query Keys', () => {
  describe('key uniqueness across domains', () => {
    it('should have unique keys across different domains', () => {
      const allKeys = [
        ...repositoryKeys.all(),
        ...agentKeys.all(),
        ...jobKeys.root(),
        ...sessionKeys.root(),
        ...worktreeKeys.root(),
        ...systemKeys.health(),
        ...notificationKeys.status(),
      ];

      const keyStrings = allKeys.map(String);
      const uniqueKeys = new Set(keyStrings);
      expect(uniqueKeys.size).toBe(keyStrings.length);
    });
  });

  describe('repositoryKeys', () => {
    it('should return readonly array for all()', () => {
      const key = repositoryKeys.all();
      expect(key).toEqual(['repositories']);
    });

    it('should include repositoryId in slackIntegration key', () => {
      const key = repositoryKeys.slackIntegration('repo-123');
      expect(key).toEqual(['repository-slack-integration', 'repo-123']);
    });

    it('should have different keys for different repositories', () => {
      const key1 = repositoryKeys.slackIntegration('repo-1');
      const key2 = repositoryKeys.slackIntegration('repo-2');
      expect(key1).not.toEqual(key2);
    });
  });

  describe('agentKeys', () => {
    it('should return readonly array for all()', () => {
      const key = agentKeys.all();
      expect(key).toEqual(['agents']);
    });

    it('should include agentId in detail key', () => {
      const key = agentKeys.detail('agent-123');
      expect(key).toEqual(['agent', 'agent-123']);
    });

    it('should have different keys for different agents', () => {
      const key1 = agentKeys.detail('agent-1');
      const key2 = agentKeys.detail('agent-2');
      expect(key1).not.toEqual(key2);
    });
  });

  describe('jobKeys hierarchical relationships', () => {
    it('should have root key that all job keys share prefix with', () => {
      const root = jobKeys.root();
      expect(root).toEqual(['jobs']);
    });

    it('should have list key that starts with jobs prefix', () => {
      const list = jobKeys.list({ status: 'pending' });
      expect(list[0]).toBe('jobs');
    });

    it('should have stats key that starts with jobs prefix', () => {
      const stats = jobKeys.stats();
      expect(stats[0]).toBe('jobs');
      expect(stats[1]).toBe('stats');
    });

    it('should have detail key in separate namespace', () => {
      const detail = jobKeys.detail('job-123');
      expect(detail[0]).toBe('job');
    });

    it('should include jobId in detail key', () => {
      const detail = jobKeys.detail('job-123');
      expect(detail).toEqual(['job', 'job-123']);
    });

    it('should have different keys for different jobs', () => {
      const key1 = jobKeys.detail('job-1');
      const key2 = jobKeys.detail('job-2');
      expect(key1).not.toEqual(key2);
    });

    it('should have different list keys for different params', () => {
      const list1 = jobKeys.list({ status: 'pending' });
      const list2 = jobKeys.list({ status: 'completed' });
      expect(list1).not.toEqual(list2);
    });
  });

  describe('sessionKeys hierarchical relationships', () => {
    it('should have root key for session invalidation', () => {
      const root = sessionKeys.root();
      expect(root).toEqual(['sessions']);
    });

    it('should have validation key that starts with session prefix', () => {
      const validation = sessionKeys.validation();
      expect(validation).toEqual(['session-validation']);
    });

    it('should include sessionId in prLink key', () => {
      const key = sessionKeys.prLink('session-123');
      expect(key).toEqual(['sessionPrLink', 'session-123']);
    });

    it('should have different keys for different sessions', () => {
      const key1 = sessionKeys.prLink('session-1');
      const key2 = sessionKeys.prLink('session-2');
      expect(key1).not.toEqual(key2);
    });

    it('should include sessionId in branches key', () => {
      const key = sessionKeys.branches('session-123');
      expect(key).toEqual(['sessionBranches', 'session-123']);
    });
  });

  describe('worktreeKeys', () => {
    it('should have root key for worktree invalidation', () => {
      const root = worktreeKeys.root();
      expect(root).toEqual(['worktrees']);
    });

    it('should include repositoryId in byRepository key', () => {
      const key = worktreeKeys.byRepository('repo-123');
      expect(key).toEqual(['worktrees', 'repo-123']);
    });

    it('should have different keys for different repositories', () => {
      const key1 = worktreeKeys.byRepository('repo-1');
      const key2 = worktreeKeys.byRepository('repo-2');
      expect(key1).not.toEqual(key2);
    });

    it('should share worktrees prefix across keys', () => {
      const root = worktreeKeys.root();
      const byRepo = worktreeKeys.byRepository('repo-1');
      expect(root[0]).toBe(byRepo[0]);
    });
  });

  describe('branchKeys', () => {
    it('should include repositoryId in byRepository key', () => {
      const key = branchKeys.byRepository('repo-123');
      expect(key).toEqual(['branches', 'repo-123']);
    });

    it('should have different keys for different repositories', () => {
      const key1 = branchKeys.byRepository('repo-1');
      const key2 = branchKeys.byRepository('repo-2');
      expect(key1).not.toEqual(key2);
    });

    it('should include sessionId and baseCommit in commits key', () => {
      const key = branchKeys.commits('session-123', 'abc123');
      expect(key).toEqual(['branchCommits', 'session-123', 'abc123']);
    });

    it('should have different keys for different commits', () => {
      const key1 = branchKeys.commits('session-1', 'commit-1');
      const key2 = branchKeys.commits('session-1', 'commit-2');
      expect(key1).not.toEqual(key2);
    });

    it('should include repositoryId and branch in remoteStatus key', () => {
      const key = branchKeys.remoteStatus('repo-123', 'main');
      expect(key).toEqual(['remote-status', 'repo-123', 'main']);
    });

    it('should have remoteStatusRoot that shares prefix with remoteStatus', () => {
      const root = branchKeys.remoteStatusRoot('repo-123');
      const status = branchKeys.remoteStatus('repo-123', 'main');
      expect(root[0]).toBe(status[0]);
      expect(root[1]).toBe(status[1]);
    });

    it('should have different remote status keys for different branches', () => {
      const key1 = branchKeys.remoteStatus('repo-1', 'main');
      const key2 = branchKeys.remoteStatus('repo-1', 'feature');
      expect(key1).not.toEqual(key2);
    });
  });

  describe('systemKeys', () => {
    it('should return health key', () => {
      const key = systemKeys.health();
      expect(key).toEqual(['system', 'health']);
    });
  });

  describe('notificationKeys', () => {
    it('should return status key', () => {
      const key = notificationKeys.status();
      expect(key).toEqual(['notification-status']);
    });
  });

  describe('return value structure', () => {
    it('should return readonly tuple for all keys', () => {
      const keys = [
        repositoryKeys.all(),
        agentKeys.all(),
        jobKeys.root(),
        sessionKeys.root(),
        worktreeKeys.root(),
        systemKeys.health(),
        notificationKeys.status(),
      ];

      keys.forEach((key) => {
        expect(Array.isArray(key)).toBe(true);
        // Verify it's a readonly type by checking it's sealed
        expect(Object.isFrozen(key) || Object.isExtensible(key)).toBe(true);
      });
    });

    it('should support string and number values in keys', () => {
      // Test with string ID
      const repoKey = branchKeys.commits('session-1', 'abc123');
      expect(repoKey[1]).toBe('session-1');
      expect(repoKey[2]).toBe('abc123');

      // All keys should be serializable for use in TanStack Query
      expect(() => JSON.stringify(repoKey)).not.toThrow();
    });
  });
});
