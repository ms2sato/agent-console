/**
 * MOVED (not copied) from
 * scripts/smoke/__tests__/probe-sdk-declared-mcp-and-task.test.ts when
 * `slugifyMcpServerName` / `isAccountConnector` / `mcpServerOf` were moved
 * into `../mcp-names.ts` (epic #1636 Phase 5 PR-2, Issue #1785). The probe
 * test file retains its own tests of `classifyBaseline` / `classifyP0`,
 * which exercise these functions indirectly but pin different production
 * functions -- those are not duplicated here.
 */
import { describe, it, expect } from 'bun:test';
import { isAccountConnector, mcpServerOf, slugifyMcpServerName } from '../mcp-names.js';

describe('mcpServerOf', () => {
  it('extracts the server segment of an MCP-namespaced tool and null otherwise', () => {
    expect(mcpServerOf('mcp__console__Compact')).toBe('console');
    expect(mcpServerOf('mcp__chrome-devtools__list_pages')).toBe('chrome-devtools');
    expect(mcpServerOf('Read')).toBeNull();
    expect(mcpServerOf('mcp__')).toBeNull();
  });
});

describe('isAccountConnector', () => {
  it('recognizes the tool-name slug form', () => {
    expect(isAccountConnector('claude_ai_Google_Drive')).toBe(true);
    expect(isAccountConnector('chrome-devtools')).toBe(false);
    expect(isAccountConnector('agent-console')).toBe(false);
  });

  /**
   * Regression for the P0 run of 2026-09-20: `system:init.mcp_servers[].name`
   * reports the SAME four claude.ai connectors as a human-readable label
   * ("claude.ai Google Calendar"), not the tool-name slug form
   * ("claude_ai_Google_Calendar"). A server with no tools yet (e.g.
   * `needs-auth`) appears ONLY in `mcp_servers`, so this label form must be
   * recognized directly -- it cannot be inferred from a tool-name prefix that
   * never arrives.
   */
  it('recognizes the account-connector class in its mcp_servers[].name label form, not only the tool-name slug form', () => {
    expect(slugifyMcpServerName('claude.ai Google Calendar')).toBe('claude_ai_Google_Calendar');
    expect(slugifyMcpServerName('claude_ai_Google_Drive')).toBe('claude_ai_Google_Drive');
    expect(slugifyMcpServerName('agent-console')).toBe('agent_console');
    expect(isAccountConnector('claude.ai Google Calendar')).toBe(true);
    expect(isAccountConnector('claude.ai Gmail')).toBe(true);
    expect(isAccountConnector('claude_ai_Google_Drive')).toBe(true); // pre-existing slug form still matches
    expect(isAccountConnector('chrome-devtools')).toBe(false);
    expect(isAccountConnector('agent-console')).toBe(false);
  });
});
