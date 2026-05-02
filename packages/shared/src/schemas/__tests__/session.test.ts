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

describe('shared field validation', () => {
  it('accepts shared: true on worktree session', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      shared: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.shared).toBe(true);
    }
  });

  it('accepts shared: false on worktree session', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      shared: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.shared).toBe(false);
    }
  });

  it('accepts shared: true on quick session', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
      shared: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.shared).toBe(true);
    }
  });

  it('accepts shared: false on quick session', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
      shared: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts when shared is omitted (optional) on worktree session', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.shared).toBeUndefined();
    }
  });

  it('accepts when shared is omitted (optional) on quick session', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.shared).toBeUndefined();
    }
  });

  it('rejects shared: "true" (string) on worktree session', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      shared: 'true',
    });
    expect(result.success).toBe(false);
  });

  it('rejects shared: "false" (string) on quick session', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
      shared: 'false',
    });
    expect(result.success).toBe(false);
  });
});

describe('templateVars key validation', () => {
  it('should accept valid alphanumeric keys', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      templateVars: { model: 'gpt-4', temperature_value: '0.7' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept templateVars with underscore keys', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
      templateVars: { my_var: 'value', _leading: 'ok' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject keys with special characters', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      templateVars: { 'invalid-key': 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject keys with spaces', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      templateVars: { 'has space': 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject reserved key "prompt"', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      templateVars: { prompt: 'hacked' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject reserved key "cwd"', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/dir',
      templateVars: { cwd: '/hacked/path' },
    });
    expect(result.success).toBe(false);
  });

  it('should accept when templateVars is omitted', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty templateVars object', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      templateVars: {},
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdateSessionRequestSchema', () => {
  it('should validate update with title', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 'New Title',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('New Title');
    }
  });

  it('should accept empty object (title is optional)', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('should trim whitespace from title', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: '  My Title  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.title).toBe('My Title');
    }
  });

  it('should reject number for title field', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 456,
    });
    expect(result.success).toBe(false);
  });

  it('should ignore unknown fields', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 'Title',
      branch: 'feature/test',
    });
    // Valibot strips unknown fields by default in v.object
    expect(result.success).toBe(true);
  });
});
