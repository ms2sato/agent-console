import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  UpdateEmbeddedAgentWorkerRequestSchema,
} from '../worker';

describe('CreateWorkerRequestSchema', () => {
  // CreateWorkerRequestSchema accepts terminal, embedded-agent, and (since
  // Issue #1023) agent worker creation params from the client.

  it('should accept terminal worker', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('terminal');
    }
  });

  it('should accept terminal worker with optional name', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      name: 'My Terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('My Terminal');
    }
  });

  it('should accept terminal worker with continueConversation', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'terminal') {
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should accept embedded-agent worker', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'embedded-agent') {
      expect(result.output.embeddedAgentId).toBe('def-1');
    }
  });

  it('should accept embedded-agent worker with optional name', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      name: 'My Embedded Agent',
    });
    expect(result.success).toBe(true);
  });

  it('should reject embedded-agent worker without embeddedAgentId', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject embedded-agent worker with empty embeddedAgentId', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject embedded-agent worker with an unknown key', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('should accept embedded-agent worker with model, reasoningEffort, and contextWindowTokens (Issue #1554)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      model: 'qwen3:32b',
      reasoningEffort: 'high',
      contextWindowTokens: 32000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'embedded-agent') {
      expect(result.output.model).toBe('qwen3:32b');
      expect(result.output.reasoningEffort).toBe('high');
      expect(result.output.contextWindowTokens).toBe(32000);
    }
  });

  it('should accept embedded-agent worker with contextWindowTokens as a positive integer boundary (1)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      contextWindowTokens: 1,
    });
    expect(result.success).toBe(true);
  });

  it('should reject embedded-agent worker with contextWindowTokens of zero (boundary)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      contextWindowTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject embedded-agent worker with a negative contextWindowTokens', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      contextWindowTokens: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject embedded-agent worker with a non-integer contextWindowTokens', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'embedded-agent',
      embeddedAgentId: 'def-1',
      contextWindowTokens: 32000.5,
    });
    expect(result.success).toBe(false);
  });

  it('should accept agent worker (Issue #1023: terminal agents addable mid-session)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'agent') {
      expect(result.output.agentId).toBe('agent-123');
    }
  });

  it('should accept agent worker with optional name and continueConversation', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      name: 'My Agent',
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'agent') {
      expect(result.output.name).toBe('My Agent');
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should accept agent worker with model and reasoningEffort (Issue #1541)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      model: 'claude-opus-4-6',
      reasoningEffort: 'high',
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'agent') {
      expect(result.output.model).toBe('claude-opus-4-6');
      expect(result.output.reasoningEffort).toBe('high');
    }
  });

  it('should trim model and reasoningEffort', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      model: '  claude-opus-4-6  ',
      reasoningEffort: '  high  ',
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'agent') {
      expect(result.output.model).toBe('claude-opus-4-6');
      expect(result.output.reasoningEffort).toBe('high');
    }
  });

  it('should reject agent worker with an empty-string model (boundary: empty is invalid, not absent)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      model: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent worker with a whitespace-only reasoningEffort (boundary)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      reasoningEffort: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent worker without agentId', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent worker with empty agentId', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should accept agent worker with contextWindowTokens (schema-level -- always rejected at createWorker() as a kind-level check, agent-surface.md Ruling 4)', () => {
    // Declared on the schema (see CreateAgentWorkerParamsSchema's own doc
    // comment) so a caller who submits it gets a domain-specific
    // ValidationError from the choke point rather than a generic
    // strictObject unknown-key 400. Schema-level parse success here does
    // NOT imply createWorker() accepts it -- see
    // worker-lifecycle-manager.test.ts's "rejects contextWindowTokens on a
    // terminal-agent worker" test for the actual rejection.
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      contextWindowTokens: 32000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'agent') {
      expect(result.output.contextWindowTokens).toBe(32000);
    }
  });

  it('should reject agent worker with an unknown key', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('should reject git-diff worker (not allowed from client)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'git-diff',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid type', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing type', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      name: 'My Terminal',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-boolean continueConversation', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      continueConversation: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for name field', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      name: 456,
    });
    expect(result.success).toBe(false);
  });
});

describe('RestartWorkerRequestSchema', () => {
  it('should validate empty request', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('should validate with continueConversation true', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success && 'continueConversation' in result.output) {
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should validate with continueConversation false', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: false,
    });
    expect(result.success).toBe(true);
    if (result.success && 'continueConversation' in result.output) {
      expect(result.output.continueConversation).toBe(false);
    }
  });

  it('should reject non-boolean continueConversation', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('should validate with valid branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/new-feature');
    }
  });

  it('should validate with all fields', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: true,
      agentId: 'agent-123',
      branch: 'feature/test',
    });
    expect(result.success).toBe(true);
  });

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '  feature/test  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/test');
    }
  });

  it('should reject empty branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should accept branch with slashes, dots, underscores, hyphens', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/test-1.0_beta',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with backslash', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature\\test',
    });
    expect(result.success).toBe(false);
  });
});

describe('RestartWorkerRequestSchema: embedded-agent conversion member (cross-type restart)', () => {
  it('accepts { embeddedAgentId } alone', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      embeddedAgentId: 'def-1',
    });
    expect(result.success).toBe(true);
    if (result.success && 'embeddedAgentId' in result.output) {
      expect(result.output.embeddedAgentId).toBe('def-1');
    }
  });

  it('accepts { embeddedAgentId, branch }', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      embeddedAgentId: 'def-1',
      branch: 'feature/convert',
    });
    expect(result.success).toBe(true);
    if (result.success && 'embeddedAgentId' in result.output) {
      expect(result.output.embeddedAgentId).toBe('def-1');
      expect(result.output.branch).toBe('feature/convert');
    }
  });

  it('rejects { embeddedAgentId, continueConversation } -- continueConversation belongs to the terminal member only', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      embeddedAgentId: 'def-1',
      continueConversation: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects { embeddedAgentId, agentId } -- agentId belongs to the terminal member only', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      embeddedAgentId: 'def-1',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty embeddedAgentId', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      embeddedAgentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('the empty object {} still matches the terminal member (today\'s behavior, unchanged)', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect('embeddedAgentId' in result.output).toBe(false);
    }
  });

  // Polarity measurement (workflow.md "TDD for bug fixes" + testing.md's
  // per-test category table), performed via `git diff
  // packages/shared/src/schemas/worker.ts > /tmp/schema.patch && git
  // checkout packages/shared/src/schemas/worker.ts`, re-running this
  // describe block, then `git apply /tmp/schema.patch` to restore:
  //
  // - The two "accepts" tests above are BUG/NEW-MECHANISM-CONTRACT tests:
  //   they FAILED against the old flat schema (which had no `embeddedAgentId`
  //   key at all -- strictObject rejected it as unrecognized) and PASS now.
  //   This is the real polarity flip for the new union member's existence.
  // - The two "rejects" tests (continueConversation / agentId alongside
  //   embeddedAgentId) are INVARIANT-PRESERVATION tests: they pass in BOTH
  //   worlds, but for different reasons. Against the old flat schema,
  //   `embeddedAgentId` itself is the unrecognized key, so `success: false`
  //   regardless of which other field accompanies it -- the co-occurrence
  //   is not what's being rejected there. Against the new union, it's the
  //   co-occurrence itself that trips strictObject's per-member key check.
  //   They are not vacuous, though: they would fail against a plausible
  //   wrong NEW implementation (e.g. one flat object merging both members'
  //   fields as all-optional instead of a true union), which is the mistake
  //   they exist to guard.
});

describe('strict-parse contract (unknown-key rejection)', () => {
  it('CreateWorkerRequestSchema rejects an unknown key', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // CreateWorkerRequestSchema is a union; the unknown-key issue surfaces on
      // the matching (terminal) branch, so assert via the serialized issues.
      expect(JSON.stringify(result.issues)).toContain('unexpectedField');
    }
  });

  it('RestartWorkerRequestSchema rejects an unknown key', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: true,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // RestartWorkerRequestSchema is now a union (cross-type restart); the
      // unknown-key issue surfaces on the matching (terminal) branch, same
      // union-issue shape as CreateWorkerRequestSchema above.
      expect(JSON.stringify(result.issues)).toContain('unexpectedField');
    }
  });
});

describe('UpdateEmbeddedAgentWorkerRequestSchema (Compaction toggle)', () => {
  it('accepts autoCompaction true and false', () => {
    expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { autoCompaction: true }).success).toBe(true);
    expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { autoCompaction: false }).success).toBe(true);
  });

  it('rejects an empty body -- an empty body is not "no change"', () => {
    // Pre-existing assertion, kept. Only the REASON moved: `autoCompaction`
    // used to be the schema's single required key, so `{}` failed on a
    // missing field. Since the mid-run parameter widening every key is
    // optional, and `{}` now fails the at-least-one-key check instead. The
    // caller-visible outcome is unchanged: an empty body would be a caller
    // bug, and accepting it as a no-op would return 200 for a request that
    // changed nothing.
    const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.message).toContain('at least one of');
    }
  });

  it('rejects a non-boolean autoCompaction', () => {
    expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { autoCompaction: 'yes' }).success).toBe(false);
    expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { autoCompaction: 1 }).success).toBe(false);
  });

  it('rejects an unknown key (strictObject)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
      autoCompaction: true,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });

  describe('mid-run model / reasoning-effort / context-window override (agent-surface.md Phase 3)', () => {
    it('accepts each field on its own', () => {
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { autoCompaction: true }).success).toBe(true);
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { reasoningEffort: 'high' }).success).toBe(true);
      // `model` alone is NOT a valid body -- Ruling 4 couples it to the
      // window, so its "alone" case is the pair below. Covered explicitly by
      // the rejection tests further down.
      expect(
        v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
          model: 'gpt-5',
          contextWindowTokens: 200_000,
        }).success,
      ).toBe(true);
    });

    it('accepts nulls, which CLEAR an override rather than leaving it alone', () => {
      // The absent-vs-null distinction is the whole reason these fields are
      // `v.optional(v.nullable(...))` rather than `v.optional(...)`.
      const cleared = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
        model: null,
        reasoningEffort: null,
      });
      expect(cleared.success).toBe(true);
      if (cleared.success) {
        expect(cleared.output.model).toBeNull();
        expect(cleared.output.reasoningEffort).toBeNull();
        // Absent stays absent: it must be distinguishable from an explicit null.
        expect('contextWindowTokens' in cleared.output).toBe(false);
      }
    });

    it('accepts a model set alongside an explicitly undeclared window (null)', () => {
      // Ruling 4's "pass null to declare no window": compaction goes inert
      // and the gauge indeterminate, which is a legitimate declared state.
      expect(
        v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
          model: 'gpt-5',
          contextWindowTokens: null,
        }).success,
      ).toBe(true);
    });

    it('accepts the empty string for model -- value validation is the shared validator, not the wire', () => {
      // Deliberately NOT `v.trim()` / `v.minLength(1)` here: normalisation
      // and rejection belong to the shared parameter validator, so trimming
      // at the wire would make that writer's own trim unmeasurable.
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
        model: '  gpt-5  ',
        contextWindowTokens: null,
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.output.model).toBe('  gpt-5  ');
    });

    it('rejects a model set with NO contextWindowTokens key at all (Ruling 4)', () => {
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { model: 'gpt-5' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain('setting a model requires contextWindowTokens');
      }
    });

    it('rejects a model CLEARED alongside a window (Ruling 4)', () => {
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
        model: null,
        contextWindowTokens: 200_000,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain('clearing the model clears the window');
      }
    });

    it('rejects a window with NO model key at all (Ruling 4)', () => {
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
        contextWindowTokens: 200_000,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain('property of a model override');
      }
    });

    it('rejects a window cleared with NO model key at all (Ruling 4, same coupling)', () => {
      // `null` is still "present" for the coupling: the window is never an
      // independently addressable setting, in either direction.
      expect(
        v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, { contextWindowTokens: null }).success,
      ).toBe(false);
    });

    it('rejects a non-positive or non-integer contextWindowTokens', () => {
      const bodyWith = (contextWindowTokens: unknown) => ({ model: 'gpt-5', contextWindowTokens });
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, bodyWith(0)).success).toBe(false);
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, bodyWith(-1)).success).toBe(false);
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, bodyWith(1.5)).success).toBe(false);
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, bodyWith('200000')).success).toBe(false);
      expect(v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, bodyWith(1)).success).toBe(true);
    });

    it('rejects an unknown key alongside the new fields (strictObject)', () => {
      const result = v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
        model: 'gpt-5',
        contextWindowTokens: 200_000,
        temperature: 0.7,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path?.[0]?.key === 'temperature')).toBe(true);
      }
    });

    it('accepts the compaction toggle and a parameter change in one body', () => {
      expect(
        v.safeParse(UpdateEmbeddedAgentWorkerRequestSchema, {
          autoCompaction: false,
          model: 'gpt-5',
          contextWindowTokens: 200_000,
          reasoningEffort: 'medium',
        }).success,
      ).toBe(true);
    });
  });
});
