import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateRepositoryRequestSchema,
  CreateWorktreeRequestSchema,
  CreateWorktreePromptRequestSchema,
  CreateWorktreeCustomRequestSchema,
  CreateWorktreeExistingRequestSchema,
  DeleteWorktreeRequestSchema,
} from '../repository';

describe('CreateRepositoryRequestSchema', () => {
  it('should validate valid repository request', () => {
    const result = v.safeParse(CreateRepositoryRequestSchema, {
      path: '/path/to/repository',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/repository');
    }
  });

  it('should trim whitespace from path', () => {
    const result = v.safeParse(CreateRepositoryRequestSchema, {
      path: '  /path/to/repository  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.path).toBe('/path/to/repository');
    }
  });

  it('should reject missing path', () => {
    const result = v.safeParse(CreateRepositoryRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('should reject empty path', () => {
    const result = v.safeParse(CreateRepositoryRequestSchema, {
      path: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only path', () => {
    const result = v.safeParse(CreateRepositoryRequestSchema, {
      path: '   ',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreePromptRequestSchema', () => {
  it('should validate valid prompt mode request', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.mode).toBe('prompt');
      expect(result.output.initialPrompt).toBe('Fix login bug');
    }
  });

  it('should validate with all optional fields', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'develop',
      autoStartSession: true,
      agentId: 'agent-123',
      title: 'Login Fix',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.baseBranch).toBe('develop');
      expect(result.output.autoStartSession).toBe(true);
      expect(result.output.agentId).toBe('agent-123');
      expect(result.output.title).toBe('Login Fix');
    }
  });

  it('should trim whitespace from initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: '  Fix login bug  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.initialPrompt).toBe('Fix login bug');
    }
  });

  it('should reject missing initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'custom',
      initialPrompt: 'Fix login bug',
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid baseBranch', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'develop',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.baseBranch).toBe('develop');
    }
  });

  it('should reject baseBranch with spaces', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'my branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject baseBranch with special characters', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should accept empty baseBranch (treated as undefined)', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: '',
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateWorktreeCustomRequestSchema', () => {
  it('should validate valid custom mode request', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature/custom-branch',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.mode).toBe('custom');
      expect(result.output.branch).toBe('feature/custom-branch');
    }
  });

  it('should validate with all optional fields', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature/custom-branch',
      baseBranch: 'main',
      autoStartSession: false,
      agentId: 'agent-456',
      initialPrompt: 'Start coding',
      title: 'Custom Branch Work',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.baseBranch).toBe('main');
      expect(result.output.autoStartSession).toBe(false);
      expect(result.output.agentId).toBe('agent-456');
      expect(result.output.initialPrompt).toBe('Start coding');
      expect(result.output.title).toBe('Custom Branch Work');
    }
  });

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: '  feature/test  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/test');
    }
  });

  it('should reject missing branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'existing',
      branch: 'feature/custom-branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid baseBranch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature/new',
      baseBranch: 'develop',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.baseBranch).toBe('develop');
    }
  });

  it('should reject baseBranch with spaces', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      mode: 'custom',
      branch: 'feature/new',
      baseBranch: 'my branch',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreeExistingRequestSchema', () => {
  it('should validate valid existing mode request', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: 'existing-branch',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.mode).toBe('existing');
      expect(result.output.branch).toBe('existing-branch');
    }
  });

  it('should validate with all optional fields', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: 'existing-branch',
      autoStartSession: true,
      agentId: 'agent-789',
      initialPrompt: 'Review code',
      title: 'Code Review',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.autoStartSession).toBe(true);
      expect(result.output.agentId).toBe('agent-789');
      expect(result.output.initialPrompt).toBe('Review code');
      expect(result.output.title).toBe('Code Review');
    }
  });

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: '  main  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('main');
    }
  });

  it('should reject missing branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'prompt',
      branch: 'existing-branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: 'my branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: 'branch@name',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      mode: 'existing',
      branch: '日本語ブランチ',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreeRequestSchema', () => {
  it('should accept prompt mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix bug',
    });
    expect(result.success).toBe(true);
  });

  it('should accept custom mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'custom',
      branch: 'feature/new',
    });
    expect(result.success).toBe(true);
  });

  it('should accept existing mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'existing',
      branch: 'main',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'invalid',
      branch: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject prompt mode without initialPrompt', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'prompt',
    });
    expect(result.success).toBe(false);
  });

  it('should reject custom mode without branch', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('should reject existing mode without branch', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'existing',
    });
    expect(result.success).toBe(false);
  });
});

describe('DeleteWorktreeRequestSchema', () => {
  it('should validate empty request', () => {
    const result = v.safeParse(DeleteWorktreeRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('should validate with force true', () => {
    const result = v.safeParse(DeleteWorktreeRequestSchema, {
      force: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.force).toBe(true);
    }
  });

  it('should validate with force false', () => {
    const result = v.safeParse(DeleteWorktreeRequestSchema, {
      force: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.force).toBe(false);
    }
  });

  it('should reject non-boolean force', () => {
    const result = v.safeParse(DeleteWorktreeRequestSchema, {
      force: 'yes',
    });
    expect(result.success).toBe(false);
  });
});
