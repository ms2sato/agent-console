import { describe, it, expect } from 'bun:test';

describe('schemas index exports', () => {
  it('should export message template schemas', async () => {
    const mod = await import('../index.js');
    expect(mod.CreateMessageTemplateRequestSchema).toBeDefined();
    expect(mod.UpdateMessageTemplateRequestSchema).toBeDefined();
    expect(mod.ReorderMessageTemplatesRequestSchema).toBeDefined();
  });

  it('should export UpdateSessionMemoRequestSchema (Issue #1569)', async () => {
    const mod = await import('../index.js');
    expect(mod.UpdateSessionMemoRequestSchema).toBeDefined();
  });
});
