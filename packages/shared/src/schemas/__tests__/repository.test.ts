import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateRepositoryRequestSchema,
  CloneRepositoryRequestSchema,
  CreateWorktreeRequestSchema,
  CreateWorktreePromptRequestSchema,
  CreateWorktreeCustomRequestSchema,
  CreateWorktreeExistingRequestSchema,
  DeleteWorktreeRequestSchema,
  DeleteRepositoryRequestSchema,
  PullWorktreeRequestSchema,
  FetchGitHubIssueRequestSchema,
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

describe('CloneRepositoryRequestSchema (Issue #834)', () => {
  describe('URL acceptance', () => {
    const accepted = [
      'https://github.com/org/repo.git',
      'git://github.com/org/repo.git',
      'ssh://git@github.com:22/org/repo.git',
      'git@github.com:org/repo.git',
    ];
    for (const url of accepted) {
      it(`accepts ${url}`, () => {
        const result = v.safeParse(CloneRepositoryRequestSchema, { url });
        expect(result.success).toBe(true);
      });
    }
  });

  describe('URL rejection (defense-in-depth boundary)', () => {
    const rejected: { name: string; url: string }[] = [
      // Cleartext HTTP rejected per CodeRabbit feedback on PR #862 -- no
      // credential-bearing clone over an unencrypted channel.
      { name: 'cleartext http://', url: 'http://example.com/org/repo' },
      // Leading dash -- argv-injection guard.
      { name: 'leading dash (argv injection)', url: '--upload-pack=evil' },
      // Absolute filesystem path -- not a valid clone source for this endpoint.
      { name: 'absolute filesystem path', url: '/etc/passwd' },
      // Whitespace in URL -- shell-injection guard.
      { name: 'embedded whitespace', url: 'https://example.com/org/repo with space' },
      // Empty.
      { name: 'empty string', url: '' },
      // Shell metacharacters (CodeRabbit reviewer asked for explicit coverage).
      { name: 'semicolon (command separator)', url: 'https://example.com/repo;touch%20x' },
      { name: 'command substitution $(...)', url: 'https://example.com/repo$(whoami)' },
      { name: 'backtick command substitution', url: 'https://example.com/repo`whoami`' },
      { name: 'pipe', url: 'https://example.com/repo|cat' },
      { name: 'ampersand background', url: 'https://example.com/repo&id' },
      { name: 'greater-than redirect', url: 'https://example.com/repo>x' },
      { name: 'control character (0x01)', url: 'https://example.com/repo' + String.fromCharCode(0x01) + 'bad' },
      { name: 'DEL character (0x7F)', url: 'https://example.com/repo' + String.fromCharCode(0x7F) + 'bad' },
    ];
    for (const { name, url } of rejected) {
      it(`rejects ${name}`, () => {
        const result = v.safeParse(CloneRepositoryRequestSchema, { url });
        expect(result.success).toBe(false);
      });
    }
  });

  describe('name validation', () => {
    it('accepts a valid name', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: 'my-repo_1.0',
      });
      expect(result.success).toBe(true);
    });
    it('rejects a name starting with -', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: '-rf',
      });
      expect(result.success).toBe(false);
    });
    it('rejects `.`', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: '.',
      });
      expect(result.success).toBe(false);
    });
    it('rejects `..`', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: '..',
      });
      expect(result.success).toBe(false);
    });
    it('rejects a name containing `..`', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: 'a..b',
      });
      expect(result.success).toBe(false);
    });
    it('rejects whitespace in name', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: 'has space',
      });
      expect(result.success).toBe(false);
    });
    it('rejects > 100 chars', () => {
      const result = v.safeParse(CloneRepositoryRequestSchema, {
        url: 'https://github.com/org/repo.git',
        name: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  it('accepts optional description', () => {
    const result = v.safeParse(CloneRepositoryRequestSchema, {
      url: 'https://github.com/org/repo.git',
      description: '  trimmed  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.description).toBe('trimmed');
    }
  });
});

describe('CreateWorktreePromptRequestSchema', () => {
  const validTaskId = 'test-task-id-123';

  it('should validate valid prompt mode request', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
      mode: 'prompt',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only initialPrompt', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      initialPrompt: 'Fix login bug',
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid baseBranch', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
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
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'my branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject baseBranch with special characters', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should accept empty baseBranch (treated as undefined)', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
      baseBranch: '',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing taskId', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty taskId', () => {
    const result = v.safeParse(CreateWorktreePromptRequestSchema, {
      taskId: '',
      mode: 'prompt',
      initialPrompt: 'Fix login bug',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreeCustomRequestSchema', () => {
  const validTaskId = 'test-task-id-123';

  it('should validate valid custom mode request', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
      mode: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: 'feature/custom-branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid baseBranch', () => {
    const result = v.safeParse(CreateWorktreeCustomRequestSchema, {
      taskId: validTaskId,
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
      taskId: validTaskId,
      mode: 'custom',
      branch: 'feature/new',
      baseBranch: 'my branch',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreeExistingRequestSchema', () => {
  const validTaskId = 'test-task-id-123';

  it('should validate valid existing mode request', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
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
      taskId: validTaskId,
      mode: 'existing',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong mode', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      branch: 'existing-branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: 'my branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: 'branch@name',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(CreateWorktreeExistingRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: '日本語ブランチ',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorktreeRequestSchema', () => {
  const validTaskId = 'test-task-id-123';

  it('should accept prompt mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
      initialPrompt: 'Fix bug',
    });
    expect(result.success).toBe(true);
  });

  it('should accept custom mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
      branch: 'feature/new',
    });
    expect(result.success).toBe(true);
  });

  it('should accept existing mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
      branch: 'main',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid mode', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'invalid',
      branch: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject prompt mode without initialPrompt', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'prompt',
    });
    expect(result.success).toBe(false);
  });

  it('should reject custom mode without branch', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'custom',
    });
    expect(result.success).toBe(false);
  });

  it('should reject existing mode without branch', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      taskId: validTaskId,
      mode: 'existing',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing taskId', () => {
    const result = v.safeParse(CreateWorktreeRequestSchema, {
      mode: 'prompt',
      initialPrompt: 'Fix bug',
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

describe('DeleteRepositoryRequestSchema (Issue #905)', () => {
  it('accepts an empty object (removeSourceRepo defaults to false)', () => {
    const result = v.safeParse(DeleteRepositoryRequestSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.removeSourceRepo).toBe(false);
    }
  });

  it('accepts removeSourceRepo: true', () => {
    const result = v.safeParse(DeleteRepositoryRequestSchema, {
      removeSourceRepo: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.removeSourceRepo).toBe(true);
    }
  });

  it('accepts removeSourceRepo: false', () => {
    const result = v.safeParse(DeleteRepositoryRequestSchema, {
      removeSourceRepo: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.removeSourceRepo).toBe(false);
    }
  });

  it('rejects non-boolean removeSourceRepo (string "yes")', () => {
    const result = v.safeParse(DeleteRepositoryRequestSchema, {
      removeSourceRepo: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean removeSourceRepo (number 1)', () => {
    const result = v.safeParse(DeleteRepositoryRequestSchema, {
      removeSourceRepo: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('PullWorktreeRequestSchema', () => {
  it('should validate valid request with worktreePath and taskId', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '/path/to/worktree',
      taskId: 'task-uuid-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.worktreePath).toBe('/path/to/worktree');
      expect(result.output.taskId).toBe('task-uuid-123');
    }
  });

  it('should trim whitespace from worktreePath', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '  /path/to/worktree  ',
      taskId: 'task-uuid-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.worktreePath).toBe('/path/to/worktree');
    }
  });

  it('should trim whitespace from taskId', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '/path/to/worktree',
      taskId: '  task-uuid-123  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.taskId).toBe('task-uuid-123');
    }
  });

  it('should reject missing worktreePath', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      taskId: 'task-uuid-123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty worktreePath', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '',
      taskId: 'task-uuid-123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only worktreePath', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '   ',
      taskId: 'task-uuid-123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing taskId', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '/path/to/worktree',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty taskId', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '/path/to/worktree',
      taskId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only taskId', () => {
    const result = v.safeParse(PullWorktreeRequestSchema, {
      worktreePath: '/path/to/worktree',
      taskId: '   ',
    });
    expect(result.success).toBe(false);
  });
});

describe('FetchGitHubIssueRequestSchema', () => {
  it('should accept a valid reference', () => {
    const result = v.safeParse(FetchGitHubIssueRequestSchema, {
      reference: 'owner/repo#123',
    });
    expect(result.success).toBe(true);
  });

  it('should trim and accept references with whitespace', () => {
    const result = v.safeParse(FetchGitHubIssueRequestSchema, {
      reference: '  #456  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.reference).toBe('#456');
    }
  });

  it('should reject empty reference', () => {
    const result = v.safeParse(FetchGitHubIssueRequestSchema, {
      reference: '',
    });
    expect(result.success).toBe(false);
  });
});
