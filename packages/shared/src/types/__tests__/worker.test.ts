import { describe, it, expect } from 'bun:test';
import {
  isPtyBackedWorker,
  canReceiveSessionMessages,
  canReceiveNotifications,
  type AgentWorker,
  type TerminalWorker,
  type GitDiffWorker,
  type EmbeddedAgentWorker,
} from '../worker.js';

const agentWorker: AgentWorker = {
  id: 'w-agent',
  name: 'Agent',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'agent',
  agentId: 'claude-code-builtin',
  activated: true,
};

const terminalWorker: TerminalWorker = {
  id: 'w-terminal',
  name: 'Terminal',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'terminal',
  activated: false,
};

const gitDiffWorker: GitDiffWorker = {
  id: 'w-git-diff',
  name: 'Git Diff',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'git-diff',
  baseCommit: 'abc123',
};

const embeddedAgentWorker: EmbeddedAgentWorker = {
  id: 'w-embedded-agent',
  name: 'Embedded Agent',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'embedded-agent',
  embeddedAgentId: 'def-1',
  activated: false,
  autoCompaction: true,
};

describe('isPtyBackedWorker', () => {
  it('returns true for an agent worker', () => {
    expect(isPtyBackedWorker(agentWorker)).toBe(true);
  });

  it('returns true for a terminal worker', () => {
    expect(isPtyBackedWorker(terminalWorker)).toBe(true);
  });

  it('returns false for a git-diff worker', () => {
    expect(isPtyBackedWorker(gitDiffWorker)).toBe(false);
  });

  it('returns false for an embedded-agent worker', () => {
    expect(isPtyBackedWorker(embeddedAgentWorker)).toBe(false);
  });

  it('narrows to a PTY-backed worker with an activated field', () => {
    const w = agentWorker as AgentWorker | TerminalWorker | GitDiffWorker;
    if (isPtyBackedWorker(w)) {
      // Type narrowing: `activated` exists on AgentWorker | TerminalWorker.
      expect(w.activated).toBe(true);
    } else {
      throw new Error('expected agent worker to be PTY-backed');
    }
  });
});

describe('canReceiveSessionMessages', () => {
  it('returns true for an agent worker', () => {
    expect(canReceiveSessionMessages(agentWorker)).toBe(true);
  });

  it('returns false for a terminal worker', () => {
    expect(canReceiveSessionMessages(terminalWorker)).toBe(false);
  });

  it('returns false for a git-diff worker', () => {
    expect(canReceiveSessionMessages(gitDiffWorker)).toBe(false);
  });

  it('returns true for an embedded-agent worker (Issue #1260 PR-2)', () => {
    expect(canReceiveSessionMessages(embeddedAgentWorker)).toBe(true);
  });

  it('narrows to an agent worker with an agentId field', () => {
    const w = agentWorker as AgentWorker | TerminalWorker | GitDiffWorker;
    if (canReceiveSessionMessages(w)) {
      // Type narrowing: `agentId` exists only on AgentWorker.
      expect(w.agentId).toBe('claude-code-builtin');
    } else {
      throw new Error('expected agent worker to receive session messages');
    }
  });

  it('narrows to an embedded-agent worker with an embeddedAgentId field', () => {
    const w = embeddedAgentWorker as AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;
    if (canReceiveSessionMessages(w) && w.type === 'embedded-agent') {
      // Type narrowing: `embeddedAgentId` exists only on EmbeddedAgentWorker.
      expect(w.embeddedAgentId).toBe('def-1');
    } else {
      throw new Error('expected embedded-agent worker to receive session messages');
    }
  });
});

describe('canReceiveNotifications', () => {
  it('returns true for an agent worker', () => {
    expect(canReceiveNotifications(agentWorker)).toBe(true);
  });

  it('returns true for a terminal worker', () => {
    expect(canReceiveNotifications(terminalWorker)).toBe(true);
  });

  it('returns true for an embedded-agent worker (notification-target parity, Issue #1574)', () => {
    expect(canReceiveNotifications(embeddedAgentWorker)).toBe(true);
  });

  it('returns false for a git-diff worker', () => {
    expect(canReceiveNotifications(gitDiffWorker)).toBe(false);
  });

  it('narrows to an embedded-agent worker with an embeddedAgentId field', () => {
    const w = embeddedAgentWorker as AgentWorker | TerminalWorker | GitDiffWorker | EmbeddedAgentWorker;
    if (canReceiveNotifications(w) && w.type === 'embedded-agent') {
      // Type narrowing: `embeddedAgentId` exists only on EmbeddedAgentWorker.
      expect(w.embeddedAgentId).toBe('def-1');
    } else {
      throw new Error('expected embedded-agent worker to receive notifications');
    }
  });
});
