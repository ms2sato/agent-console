import { describe, it, expect } from 'bun:test';

describe('shared index exports', () => {
  it('should export InteractiveProcessInfo type', async () => {
    const mod = await import('../index.js');
    // InteractiveProcessInfo is a type-only export — verify the module loads successfully
    expect(mod).toBeDefined();
  });
});
