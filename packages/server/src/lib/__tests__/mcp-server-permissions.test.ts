import { describe, it, expect } from 'bun:test';
import { listAllowedProjectMcpServerPairs, resolvePermissionDecisions } from '../mcp-server-permissions.js';
import type {
  McpServerPermissionRepository,
  McpServerPermissionRow,
} from '../../repositories/mcp-server-permission-repository.js';
import type { EmbeddedAgentWorker } from '@agent-console/shared';

function row(overrides: Partial<McpServerPermissionRow> = {}): McpServerPermissionRow {
  return {
    id: 'row-1',
    repositoryId: 'repo-1',
    serverName: 'my-server',
    configHash: 'h1',
    decision: 'allow',
    decidedBy: 'user-1',
    createdAt: '2026-09-21T00:00:00.000Z',
    decidedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function fakeRepository(rows: McpServerPermissionRow[]): Pick<McpServerPermissionRepository, 'listByRepository'> {
  return {
    listByRepository: async () => rows,
  };
}

describe('listAllowedProjectMcpServerPairs', () => {
  it('maps allow rows to (name, hash) pairs', async () => {
    const repository = fakeRepository([
      row({ serverName: 'a', configHash: 'ha', decision: 'allow' }),
      row({ serverName: 'b', configHash: 'hb', decision: 'allow' }),
    ]);
    expect(await listAllowedProjectMcpServerPairs(repository, 'repo-1')).toEqual([
      { name: 'a', hash: 'ha' },
      { name: 'b', hash: 'hb' },
    ]);
  });

  it('excludes deny rows', async () => {
    const repository = fakeRepository([
      row({ serverName: 'a', configHash: 'ha', decision: 'allow' }),
      row({ serverName: 'b', configHash: 'hb', decision: 'deny' }),
    ]);
    expect(await listAllowedProjectMcpServerPairs(repository, 'repo-1')).toEqual([{ name: 'a', hash: 'ha' }]);
  });

  it('returns an empty array when the repository has no rows (boundary value)', async () => {
    expect(await listAllowedProjectMcpServerPairs(fakeRepository([]), 'repo-1')).toEqual([]);
  });

  it('returns an empty array when every row is a deny (boundary value)', async () => {
    const repository = fakeRepository([row({ decision: 'deny' })]);
    expect(await listAllowedProjectMcpServerPairs(repository, 'repo-1')).toEqual([]);
  });
});

type Discovered = EmbeddedAgentWorker['mcpServers'];

function discoveredEntry(overrides: Partial<NonNullable<Discovered>[number]> = {}): NonNullable<Discovered>[number] {
  return {
    name: 'my-server',
    scope: 'project',
    hash: 'h1',
    decision: 'pending',
    ...overrides,
  };
}

describe('resolvePermissionDecisions', () => {
  it('resolves a named pair to a single allow decision', () => {
    const discovered: Discovered = [discoveredEntry({ name: 'a', hash: 'ha', decision: 'pending' })];
    const result = resolvePermissionDecisions(discovered, { name: 'a', hash: 'ha', decision: 'allow' });
    expect(result).toEqual({ ok: true, decisions: [{ name: 'a', hash: 'ha', decision: 'allow' }] });
  });

  it('resolves a named pair to a single deny decision', () => {
    const discovered: Discovered = [discoveredEntry({ name: 'a', hash: 'ha', decision: 'allowed' })];
    const result = resolvePermissionDecisions(discovered, { name: 'a', hash: 'ha', decision: 'deny' });
    expect(result).toEqual({ ok: true, decisions: [{ name: 'a', hash: 'ha', decision: 'deny' }] });
  });

  it('returns not-discovered for a name/hash pair never seen (boundary: empty discovered)', () => {
    const result = resolvePermissionDecisions(undefined, { name: 'a', hash: 'ha', decision: 'allow' });
    expect(result).toEqual({
      ok: false,
      kind: 'not-discovered',
      message: "MCP server 'a' with hash 'ha'",
    });
  });

  it('returns not-discovered when the name matches but the hash differs (keyed on the hash)', () => {
    const discovered: Discovered = [discoveredEntry({ name: 'a', hash: 'ha', decision: 'pending' })];
    const result = resolvePermissionDecisions(discovered, { name: 'a', hash: 'different-hash', decision: 'allow' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('not-discovered');
  });

  it('returns undecidable for a rejected-reserved pair', () => {
    const discovered: Discovered = [discoveredEntry({ name: 'a', hash: 'ha', decision: 'rejected-reserved' })];
    const result = resolvePermissionDecisions(discovered, { name: 'a', hash: 'ha', decision: 'allow' });
    expect(result).toEqual({
      ok: false,
      kind: 'undecidable',
      message: "A permission decision cannot be recorded for 'a': its discovered decision is 'rejected-reserved'",
    });
  });

  it('returns undecidable for an invalid pair', () => {
    const discovered: Discovered = [discoveredEntry({ name: 'a', hash: 'ha', decision: 'invalid' })];
    const result = resolvePermissionDecisions(discovered, { name: 'a', hash: 'ha', decision: 'deny' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('undecidable');
  });

  it('{ all: true } with undefined discovered (never activated) resolves ok with zero decisions (boundary value)', () => {
    const result = resolvePermissionDecisions(undefined, { all: true });
    expect(result).toEqual({ ok: true, decisions: [] });
  });

  it('{ all: true } with an empty discovered array resolves ok with zero decisions (boundary value)', () => {
    const result = resolvePermissionDecisions([], { all: true });
    expect(result).toEqual({ ok: true, decisions: [] });
  });

  it('{ all: true } when every row is already decided resolves ok with zero decisions (nothing re-written)', () => {
    const discovered: Discovered = [
      discoveredEntry({ name: 'a', hash: 'ha', decision: 'allowed' }),
      discoveredEntry({ name: 'b', hash: 'hb', decision: 'denied' }),
      discoveredEntry({ name: 'c', hash: 'hc', decision: 'invalid' }),
    ];
    const result = resolvePermissionDecisions(discovered, { all: true });
    expect(result).toEqual({ ok: true, decisions: [] });
  });

  it('{ all: true } allows every pending pair among allowed/denied/invalid siblings, and no others', () => {
    const discovered: Discovered = [
      discoveredEntry({ name: 'pending-1', hash: 'h1', decision: 'pending' }),
      discoveredEntry({ name: 'already-allowed', hash: 'h2', decision: 'allowed' }),
      discoveredEntry({ name: 'already-denied', hash: 'h3', decision: 'denied' }),
      discoveredEntry({ name: 'bad', hash: 'h4', decision: 'invalid' }),
      discoveredEntry({ name: 'pending-2', hash: 'h5', decision: 'pending' }),
    ];
    const result = resolvePermissionDecisions(discovered, { all: true });
    expect(result).toEqual({
      ok: true,
      decisions: [
        { name: 'pending-1', hash: 'h1', decision: 'allow' },
        { name: 'pending-2', hash: 'h5', decision: 'allow' },
      ],
    });
  });
});
