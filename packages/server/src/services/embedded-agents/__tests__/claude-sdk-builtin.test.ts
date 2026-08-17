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

  it('opts into CLAUDE.md via instructions[] (the only Phase-1 path into the SDK engine\'s context, since settingSources: [] disables native auto-discovery)', () => {
    expect(claudeSdkAgent.instructions).toEqual(['CLAUDE.md']);
  });
});
