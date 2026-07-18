import { describe, it, expect } from 'bun:test';
import { getRegisteredMcpToolNames } from '../mcp-tool-names-helper.js';

describe('getRegisteredMcpToolNames', () => {
  it('finds real tool registrations in the actual mcp-server.ts source', async () => {
    const names = await getRegisteredMcpToolNames();

    expect(names.has('list_agents')).toBe(true);
    expect(names.has('delegate_to_worktree')).toBe(true);
  });

  it('does not vacuously match a name that is not registered', async () => {
    const names = await getRegisteredMcpToolNames();

    expect(names.has('this_tool_does_not_exist')).toBe(false);
  });
});
