// The other embedded-agent engine's own literal is `openai-api` (#1364;
// formerly `native-loop`) -- production `claude-sdk-builtin.ts` only names
// it in a comment, so no assertion here changes.
import { describe, it, expect } from 'bun:test';
import { claudeSdkAgent, CLAUDE_SDK_AGENT_ID, CLAUDE_SDK_AGENT_CREATED_BY } from '../claude-sdk-builtin.js';

describe('claudeSdkAgent', () => {
  it('is a claude-sdk engine definition with no baseUrl/apiKeyRef on provider', () => {
    expect(claudeSdkAgent.engine).toBe('claude-sdk');
    expect(claudeSdkAgent.provider).toEqual({ model: 'claude-sonnet-5' });
    expect('baseUrl' in claudeSdkAgent.provider).toBe(false);
    expect('apiKeyRef' in claudeSdkAgent.provider).toBe(false);
  });

  it('is marked as built-in', () => {
    expect(claudeSdkAgent.isBuiltIn).toBe(true);
  });

  it('uses the stable id constant', () => {
    expect(claudeSdkAgent.id).toBe(CLAUDE_SDK_AGENT_ID);
    expect(claudeSdkAgent.id).toBe('claude-sdk-builtin');
  });

  it('uses the CLAUDE_SDK_AGENT_CREATED_BY sentinel as createdBy', () => {
    expect(claudeSdkAgent.createdBy).toBe(CLAUDE_SDK_AGENT_CREATED_BY);
  });

  it('uses epoch timestamps, matching claude-code.ts\'s built-in convention', () => {
    expect(claudeSdkAgent.createdAt).toBe(new Date(0).toISOString());
    expect(claudeSdkAgent.updatedAt).toBe(new Date(0).toISOString());
  });

  it('has a non-empty display name', () => {
    expect(claudeSdkAgent.name.length).toBeGreaterThan(0);
  });

  it('has no instructions[] opt-in entry (Issue #1343 Phase A, R1 -- main.ts\'s claude-sdk arm now calls loadInstructions directly, so CLAUDE.md/AGENTS.md are discovered via the chain layer without a per-definition opt-in)', () => {
    expect(claudeSdkAgent.instructions).toBeUndefined();
  });
});
