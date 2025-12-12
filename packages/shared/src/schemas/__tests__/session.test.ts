import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateSessionRequestSchema,
  CreateWorktreeSessionRequestSchema,
  CreateQuickSessionRequestSchema,
  UpdateSessionRequestSchema,
} from '../session';

describe('CreateWorktreeSessionRequestSchema', () => {
  it('should validate valid worktree session request', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('worktree');
      expect(result.output.repositoryId).toBe('repo-123');
      expect(result.output.worktreeId).toBe('wt-456');
      expect(result.output.locationPath).toBe('/path/to/worktree');
    }
  });

  it('should validate with optional fields', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      agentId: 'agent-789',
      continueConversation: true,
      initialPrompt: 'Start working',
      title: 'My Session',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.agentId).toBe('agent-789');
      expect(result.output.continueConversation).toBe(true);
      expect(result.output.initialPrompt).toBe('Start working');
      expect(result.output.title).toBe('My Session');
    }
  });

  it('should reject missing repositoryId', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty repositoryId', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: '',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing worktreeId', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty worktreeId', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: '',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing locationPath', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty locationPath', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong type', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'quick',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateQuickSessionRequestSchema', () => {
  it('should validate valid quick session request', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('quick');
      expect(result.output.locationPath).toBe('/path/to/directory');
    }
  });

  it('should validate with optional fields', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
      agentId: 'agent-789',
      continueConversation: false,
      initialPrompt: 'Quick task',
      title: 'Quick Session',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.agentId).toBe('agent-789');
      expect(result.output.continueConversation).toBe(false);
      expect(result.output.initialPrompt).toBe('Quick task');
      expect(result.output.title).toBe('Quick Session');
    }
  });

  it('should trim whitespace from locationPath', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '  /path/to/directory  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.locationPath).toBe('/path/to/directory');
    }
  });

  it('should reject missing locationPath', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty locationPath', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only locationPath', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong type', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'worktree',
      locationPath: '/path/to/directory',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateSessionRequestSchema', () => {
  it('should accept worktree session', () => {
    const result = v.safeParse(CreateSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(true);
  });

  it('should accept quick session', () => {
    const result = v.safeParse(CreateSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid type', () => {
    const result = v.safeParse(CreateSessionRequestSchema, {
      type: 'invalid',
      locationPath: '/path/to/directory',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateSessionRequestSchema', () => {
  it('should validate update with title only', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 'New Title',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
    }
  });

  it('should validate update with branch only', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/new-feature');
    }
  });

  it('should validate update with both title and branch', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 'New Title',
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty object (no fields)', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject empty branch name', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch name', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: '  feature/test  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/test');
    }
  });

  it('should accept valid branch with slashes', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/sub/branch',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with dots', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'release-1.2.3',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with underscores', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature_branch',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with hyphens', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature-branch',
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid branch with mixed valid characters', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/test-1.0_beta',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with hash', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature#branch',
    });
    expect(result.success).toBe(false);
  });

  // Branch name boundary tests
  it('should accept branch starting with slash', () => {
    // Git allows branches starting with slash
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: '/feature',
    });
    expect(result.success).toBe(true);
  });

  it('should accept branch ending with slash', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/',
    });
    expect(result.success).toBe(true);
  });

  it('should accept branch with double slashes', () => {
    // The regex allows // - this is valid per current implementation
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature//test',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with emoji', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature/🚀',
    });
    expect(result.success).toBe(false);
  });

  it('should accept branch starting with dot', () => {
    // The regex allows branches starting with dot
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: '.hidden-branch',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with backslash', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature\\test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with asterisk', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 'feature*',
    });
    expect(result.success).toBe(false);
  });

  // Type mismatch tests
  it('should reject number for branch field', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: 123,
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for title field', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 456,
    });
    expect(result.success).toBe(false);
  });

  it('should reject object for branch field', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: { name: 'feature/test' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject null for branch field', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      branch: null,
    });
    expect(result.success).toBe(false);
  });
});
