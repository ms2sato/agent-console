import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateSessionRequestSchema,
  CreateWorktreeSessionRequestSchema,
  CreateQuickSessionRequestSchema,
  UpdateSessionRequestSchema,
  RestoreInfoMessageSchema,
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

  it('should accept model and reasoningEffort (Issue #1541)', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      agentId: 'agent-789',
      model: 'claude-opus-4-6',
      reasoningEffort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.model).toBe('claude-opus-4-6');
      expect(result.output.reasoningEffort).toBe('high');
    }
  });

  it('should reject an empty-string model (boundary: empty is invalid, not absent)', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      model: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a whitespace-only reasoningEffort (boundary)', () => {
    const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
      type: 'worktree',
      repositoryId: 'repo-123',
      worktreeId: 'wt-456',
      locationPath: '/path/to/worktree',
      reasoningEffort: '   ',
    });
    expect(result.success).toBe(false);
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

  describe('embeddedAgentId (Issue #1038)', () => {
    it('should accept embeddedAgentId alone', () => {
      const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
        type: 'worktree',
        repositoryId: 'repo-123',
        worktreeId: 'wt-456',
        locationPath: '/path/to/worktree',
        embeddedAgentId: 'embedded-agent-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.embeddedAgentId).toBe('embedded-agent-123');
      }
    });

    it('should accept neither agentId nor embeddedAgentId (backward compat)', () => {
      const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
        type: 'worktree',
        repositoryId: 'repo-123',
        worktreeId: 'wt-456',
        locationPath: '/path/to/worktree',
      });
      expect(result.success).toBe(true);
    });

    it('should reject both agentId and embeddedAgentId set', () => {
      const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
        type: 'worktree',
        repositoryId: 'repo-123',
        worktreeId: 'wt-456',
        locationPath: '/path/to/worktree',
        agentId: 'agent-123',
        embeddedAgentId: 'embedded-agent-123',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty embeddedAgentId', () => {
      const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
        type: 'worktree',
        repositoryId: 'repo-123',
        worktreeId: 'wt-456',
        locationPath: '/path/to/worktree',
        embeddedAgentId: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only embeddedAgentId', () => {
      const result = v.safeParse(CreateWorktreeSessionRequestSchema, {
        type: 'worktree',
        repositoryId: 'repo-123',
        worktreeId: 'wt-456',
        locationPath: '/path/to/worktree',
        embeddedAgentId: '   ',
      });
      expect(result.success).toBe(false);
    });
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

  it('should accept model and reasoningEffort (Issue #1541)', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
      agentId: 'agent-789',
      model: 'claude-opus-4-6',
      reasoningEffort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.model).toBe('claude-opus-4-6');
      expect(result.output.reasoningEffort).toBe('high');
    }
  });

  it('should reject an empty-string model (boundary: empty is invalid, not absent)', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
      model: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a whitespace-only reasoningEffort (boundary)', () => {
    const result = v.safeParse(CreateQuickSessionRequestSchema, {
      type: 'quick',
      locationPath: '/path/to/directory',
      reasoningEffort: '   ',
    });
    expect(result.success).toBe(false);
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

  describe('embeddedAgentId (Issue #1038)', () => {
    it('should accept embeddedAgentId alone', () => {
      const result = v.safeParse(CreateQuickSessionRequestSchema, {
        type: 'quick',
        locationPath: '/path/to/directory',
        embeddedAgentId: 'embedded-agent-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.embeddedAgentId).toBe('embedded-agent-123');
      }
    });

    it('should accept neither agentId nor embeddedAgentId (backward compat)', () => {
      const result = v.safeParse(CreateQuickSessionRequestSchema, {
        type: 'quick',
        locationPath: '/path/to/directory',
      });
      expect(result.success).toBe(true);
    });

    it('should reject both agentId and embeddedAgentId set', () => {
      const result = v.safeParse(CreateQuickSessionRequestSchema, {
        type: 'quick',
        locationPath: '/path/to/directory',
        agentId: 'agent-123',
        embeddedAgentId: 'embedded-agent-123',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty embeddedAgentId', () => {
      const result = v.safeParse(CreateQuickSessionRequestSchema, {
        type: 'quick',
        locationPath: '/path/to/directory',
        embeddedAgentId: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only embeddedAgentId', () => {
      const result = v.safeParse(CreateQuickSessionRequestSchema, {
        type: 'quick',
        locationPath: '/path/to/directory',
        embeddedAgentId: '   ',
      });
      expect(result.success).toBe(false);
    });
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

  it('should reject unknown fields (strict schema)', () => {
    const result = v.safeParse(UpdateSessionRequestSchema, {
      title: 'Title',
      branch: 'feature/test',
    });
    // The schema is a strictObject: unknown keys are rejected, not stripped.
    expect(result.success).toBe(false);
  });
});

describe('RestoreInfoMessageSchema (Transcript Restore #1123)', () => {
  it('accepts a valid restore-info message', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 42,
      restoredMessageCount: 5,
      repairedToolCallIds: ['call-1', 'call-2'],
      completed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({
        type: 'restore-info',
        epoch: 42,
        restoredMessageCount: 5,
        repairedToolCallIds: ['call-1', 'call-2'],
        completed: true,
      });
    }
  });

  it('accepts an empty repairedToolCallIds array (no repair needed)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a wrong literal type', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'history',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative epoch', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: -1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a fractional restoredMessageCount', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 1.5,
      repairedToolCallIds: [],
      completed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string entry in repairedToolCallIds', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 1,
      repairedToolCallIds: [42],
      completed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing completed field (strictObject requires it)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean completed field', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: 'true',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field (strictObject)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: false,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });
});

describe('RestoreInfoMessageSchema — sdkResumed (Transcript Restore R1, #1410)', () => {
  const base = { type: 'restore-info', epoch: 3, restoredMessageCount: 2, repairedToolCallIds: [], completed: true };

  // The field is THREE-valued on the wire, and the schema is where that
  // survives or is lost: valibot's default object strips unknown keys, so a
  // member missing here means the field vanishes between server and client
  // with no error on either side.
  it('carries `true` through the parse', () => {
    expect(v.parse(RestoreInfoMessageSchema, { ...base, sdkResumed: true }).sdkResumed).toBe(true);
  });

  it('carries `false` through the parse', () => {
    expect(v.parse(RestoreInfoMessageSchema, { ...base, sdkResumed: false }).sdkResumed).toBe(false);
  });

  it('leaves the field absent rather than defaulting it', () => {
    // Absence means "this engine has no such concept" and is a different wire
    // state from `false`. A default here would erase that distinction.
    const parsed = v.parse(RestoreInfoMessageSchema, base);
    expect('sdkResumed' in parsed).toBe(false);
  });

  it('rejects a non-boolean sdkResumed', () => {
    expect(v.safeParse(RestoreInfoMessageSchema, { ...base, sdkResumed: 1 }).success).toBe(false);
  });
});

// MUTATION MEASURED (whole describe block below): removing the success
// branch's `failed: v.optional(v.literal(false))` field makes
// 'accepts failed: false explicitly, but still requires the success form's
// fields' fail -- `{failed: false, ...successFields}` no longer matches the
// (now-narrower) success branch's strictObject, and `false` does not match
// the failure branch's `v.literal(true)` either, so the union rejects the
// whole payload. Restoring the field returns the suite to green.
describe('RestoreInfoMessageSchema — FAILURE form (#1449)', () => {
  it('accepts the minimal failure form (no sdkResumed -- openai-api)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ type: 'restore-info', epoch: 5, failed: true });
      expect('sdkResumed' in result.output).toBe(false);
    }
  });

  it('accepts the failure form with sdkResumed (claude-sdk)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      sdkResumed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.sdkResumed).toBe(true);
    }
  });

  it('carries sdkResumed: false through the failure form parse', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      sdkResumed: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.sdkResumed).toBe(false);
    }
  });

  it('rejects failed: true combined with a success-only field (completed) -- each branch is a strictObject', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      completed: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects failed: true combined with restoredMessageCount', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      restoredMessageCount: 2,
    });
    expect(result.success).toBe(false);
  });

  it('accepts failed: false explicitly, but still requires the success form\'s fields', () => {
    const missingFields = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: false,
    });
    expect(missingFields.success).toBe(false);

    const complete = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: false,
      restoredMessageCount: 2,
      repairedToolCallIds: [],
      completed: true,
    });
    expect(complete.success).toBe(true);
  });

  it('rejects a non-boolean sdkResumed on the failure form', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      sdkResumed: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field on the failure form (strictObject)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('rejects failed: "true" (string, not boolean)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: 'true',
    });
    expect(result.success).toBe(false);
  });
});

describe('RestoreInfoMessageSchema — FAILURE form preservation (R4, #1447 stage 4)', () => {
  it('parses each of the three valid preservation values', () => {
    for (const preservation of ['in-band', 'sidecar', 'lost'] as const) {
      const result = v.safeParse(RestoreInfoMessageSchema, {
        type: 'restore-info',
        epoch: 5,
        failed: true,
        preservation,
      });
      expect(result.success).toBe(true);
      if (!result.success) continue;
      // Asserted explicitly (not just narrowed on) so a schema regression
      // that silently routed this input to the SUCCESS branch fails loudly
      // here instead of vacuously skipping the `preservation` check below.
      expect(result.output.failed).toBe(true);
      if (result.output.failed === true) {
        expect(result.output.preservation).toBe(preservation);
      }
    }
  });

  it('rejects a preservation value outside the three-member union', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      preservation: 'diagnostic-copy',
    });
    expect(result.success).toBe(false);
  });

  it('parses WITHOUT preservation at all -- the wire-compat requirement for a pre-stage-4 server', () => {
    // Absence must remain a genuinely valid failure-form message: an older
    // server that has never heard of `preservation` still produces a
    // failure form the client must render (with today's unconditional
    // copy), not reject at the schema boundary.
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('preservation' in result.output).toBe(false);
    }
  });

  it('combines with sdkResumed on the same failure form (both fields apply identically)', () => {
    const result = v.safeParse(RestoreInfoMessageSchema, {
      type: 'restore-info',
      epoch: 5,
      failed: true,
      sdkResumed: true,
      preservation: 'sidecar',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output.failed).toBe(true);
    if (result.output.failed === true) {
      expect(result.output.sdkResumed).toBe(true);
      expect(result.output.preservation).toBe('sidecar');
    }
  });
});
