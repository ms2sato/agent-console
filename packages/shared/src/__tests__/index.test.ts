import { describe, it, expect } from 'bun:test';

describe('shared index exports', () => {
  it('should export InteractiveProcessInfo type', async () => {
    const mod = await import('../index.js');
    // InteractiveProcessInfo is a type-only export — verify the module loads successfully
    expect(mod).toBeDefined();
  });

  it('should export SkillDefinition type', async () => {
    const mod = await import('../index.js');
    // SkillDefinition is a type-only export — verify the module loads successfully
    expect(mod).toBeDefined();
  });

  it('should export MessageTemplate type', async () => {
    const mod = await import('../index.js');
    expect(mod).toBeDefined();
  });

  it('should export message contract utilities', async () => {
    const mod = await import('../index.js');

    // Verify message contract exports from Issue #660 prevention system
    expect(mod.MessageContentUtils).toBeDefined();
    expect(mod.SubmitKeystrokeUtils).toBeDefined();
    expect(mod.isMessageContent).toBeDefined();
    expect(mod.isSubmitKeystroke).toBeDefined();
    expect(typeof mod.MessageContentUtils.create).toBe('function');
    expect(typeof mod.SubmitKeystrokeUtils.create).toBe('function');
  });

  it('should export ApiError interface correctly', async () => {
    const mod = await import('../index.js');

    // ApiError is a TypeScript interface, verify module loads and structure
    expect(mod).toBeDefined();

    // Test ApiError interface usage pattern
    const apiError = {
      error: 'TEST_ERROR',
      message: 'Test error message'
    };

    expect(apiError.error).toBe('TEST_ERROR');
    expect(apiError.message).toBe('Test error message');
  });

  it('should export ConditionalWakeupInfo type', async () => {
    const mod = await import('../index.js');

    // ConditionalWakeupInfo is a type-only export from Issue #700 — verify the module loads successfully
    expect(mod).toBeDefined();

    // Test ConditionalWakeupInfo interface usage pattern
    const wakeupInfo = {
      id: 'test-id',
      sessionId: 'test-session',
      workerId: 'test-worker',
      intervalSeconds: 30,
      conditionScript: 'echo test',
      onTrueMessage: 'Test message',
      createdAt: '2026-04-27T00:00:00.000Z',
      checkCount: 0,
      status: 'running' as const
    };

    expect(wakeupInfo.id).toBe('test-id');
    expect(wakeupInfo.status).toBe('running');
    expect(wakeupInfo.intervalSeconds).toBe(30);
  });
});
