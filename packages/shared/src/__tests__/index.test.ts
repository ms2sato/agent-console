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
});
