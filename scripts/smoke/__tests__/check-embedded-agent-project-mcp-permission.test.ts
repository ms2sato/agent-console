import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import {
  parseArgs,
  findDiscoveredServer,
  hasToolCallForServer,
  hasUserOrLocalScopeEntry,
  anyUserLocalNamesUnavailable,
  isSessionStatusPayload,
} from '../check-embedded-agent-project-mcp-permission.js';

/**
 * Pure-function tests for `check-embedded-agent-project-mcp-permission.ts`.
 * Never runs `main()` -- no `AppContext`, no `/mcp`, no billed turn.
 */

describe('check-embedded-agent-project-mcp-permission smoke: parseArgs', () => {
  it('defaults expectNoPermission to false with no flags', () => {
    expect(parseArgs([])).toEqual({ expectNoPermission: false });
  });

  it('sets expectNoPermission on --expect-no-permission', () => {
    expect(parseArgs(['--expect-no-permission'])).toEqual({ expectNoPermission: true });
  });

  it('tolerates a leading -- separator', () => {
    expect(parseArgs(['--', '--expect-no-permission'])).toEqual({ expectNoPermission: true });
  });

  it('exits 2 with a usage error for an unknown flag (real subprocess)', () => {
    const scriptPath = path.join(import.meta.dir, '../check-embedded-agent-project-mcp-permission.ts');
    const proc = Bun.spawnSync([process.execPath, scriptPath, '--bogus'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('unknown flag: --bogus');
  });
});

describe('check-embedded-agent-project-mcp-permission smoke: findDiscoveredServer', () => {
  it('finds an entry by name', () => {
    const servers = [
      { name: 'srv-allowed', scope: 'project', hash: 'h1', decision: 'pending' },
      { name: 'srv-pending', scope: 'project', hash: 'h2', decision: 'pending' },
    ];
    expect(findDiscoveredServer(servers, 'srv-pending')).toEqual(servers[1]);
  });

  it('returns undefined for an absent name or an undefined array', () => {
    expect(findDiscoveredServer([{ name: 'x', scope: 'project' }], 'y')).toBeUndefined();
    expect(findDiscoveredServer(undefined, 'y')).toBeUndefined();
  });
});

describe('check-embedded-agent-project-mcp-permission smoke: hasToolCallForServer', () => {
  it('matches a tool-call event whose name is namespaced under the server', () => {
    const events = [{ type: 'tool-call', name: 'mcp__srv-allowed__probe_echo' }];
    expect(hasToolCallForServer(events, 'srv-allowed')).toBe(true);
  });

  it('does not match a different server\'s namespaced tool, or a non-tool-call event', () => {
    const events = [
      { type: 'tool-call', name: 'mcp__srv-pending__probe_echo' },
      { type: 'assistant-message', text: 'mcp__srv-allowed__probe_echo mentioned in prose' },
    ];
    expect(hasToolCallForServer(events, 'srv-allowed')).toBe(false);
  });

  it('returns false on an empty events array', () => {
    expect(hasToolCallForServer([], 'srv-allowed')).toBe(false);
  });
});

describe('check-embedded-agent-project-mcp-permission smoke: hasUserOrLocalScopeEntry', () => {
  it('detects a user-scope row inside a mcp-servers-discovered event', () => {
    const events = [
      { type: 'mcp-servers-discovered', servers: [{ name: 'agent-console', scope: 'reserved' }, { name: 'leaked', scope: 'user' }] },
    ];
    expect(hasUserOrLocalScopeEntry(events)).toBe(true);
  });

  it('detects a local-scope row too', () => {
    const events = [{ type: 'mcp-servers-discovered', servers: [{ name: 'x', scope: 'local' }] }];
    expect(hasUserOrLocalScopeEntry(events)).toBe(true);
  });

  it('returns false when only project/reserved rows are present, or on an empty array', () => {
    const events = [
      { type: 'mcp-servers-discovered', servers: [{ name: 'agent-console', scope: 'reserved' }, { name: 'srv-allowed', scope: 'project' }] },
    ];
    expect(hasUserOrLocalScopeEntry(events)).toBe(false);
    expect(hasUserOrLocalScopeEntry([])).toBe(false);
  });

  it('ignores non-discovered events and a malformed (non-array) servers field', () => {
    const events = [
      { type: 'tool-call', name: 'mcp__x__y' },
      { type: 'mcp-servers-discovered', servers: 'not-an-array' },
    ];
    expect(hasUserOrLocalScopeEntry(events)).toBe(false);
  });
});

describe('check-embedded-agent-project-mcp-permission smoke: anyUserLocalNamesUnavailable', () => {
  it('detects the flag when true', () => {
    const events = [{ type: 'mcp-servers-discovered', servers: [], userLocalNamesUnavailable: true }];
    expect(anyUserLocalNamesUnavailable(events)).toBe(true);
  });

  it('returns false when the flag is absent, or on an empty array', () => {
    expect(anyUserLocalNamesUnavailable([{ type: 'mcp-servers-discovered', servers: [] }])).toBe(false);
    expect(anyUserLocalNamesUnavailable([])).toBe(false);
  });
});

describe('check-embedded-agent-project-mcp-permission smoke: isSessionStatusPayload', () => {
  it('accepts an object with a workers array (empty or populated)', () => {
    expect(isSessionStatusPayload({ workers: [] })).toBe(true);
    expect(isSessionStatusPayload({ workers: [{ id: 'w1', mcpServers: [] }] })).toBe(true);
  });

  it('rejects undefined -- the shape callMcpTool returns when there is no content block or JSON.parse failed', () => {
    expect(isSessionStatusPayload(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isSessionStatusPayload(null)).toBe(false);
  });

  it('rejects an object with no workers property', () => {
    expect(isSessionStatusPayload({})).toBe(false);
  });

  it('rejects an object whose workers property is not an array', () => {
    expect(isSessionStatusPayload({ workers: 'not-an-array' })).toBe(false);
    expect(isSessionStatusPayload({ workers: {} })).toBe(false);
    expect(isSessionStatusPayload({ workers: null })).toBe(false);
  });

  it('rejects a bare array or primitive (the object-ness check)', () => {
    expect(isSessionStatusPayload([])).toBe(false);
    expect(isSessionStatusPayload('workers')).toBe(false);
    expect(isSessionStatusPayload(42)).toBe(false);
  });
});
