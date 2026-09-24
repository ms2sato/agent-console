import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import {
  listAllowedProjectMcpServerPairs,
  resolvePermissionDecisions,
  resolveMcpPermissionScope,
  type McpPermissionScope,
} from '../mcp-server-permissions.js';
import type {
  McpServerPermissionRepository,
  McpServerPermissionRow,
} from '../../repositories/mcp-server-permission-repository.js';
import type { EmbeddedAgentWorker } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';

const REPO_SCOPE: McpPermissionScope = { kind: 'repository', repositoryId: 'repo-1' };

function row(overrides: Partial<McpServerPermissionRow> = {}): McpServerPermissionRow {
  return {
    id: 'row-1',
    scope: REPO_SCOPE,
    serverName: 'my-server',
    configHash: 'h1',
    decision: 'allow',
    decidedBy: 'user-1',
    createdAt: '2026-09-21T00:00:00.000Z',
    decidedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function fakeRepository(rows: McpServerPermissionRow[]): Pick<McpServerPermissionRepository, 'listByScope'> {
  return {
    listByScope: async () => rows,
  };
}

describe('listAllowedProjectMcpServerPairs', () => {
  it('maps allow rows to (name, hash) pairs', async () => {
    const repository = fakeRepository([
      row({ serverName: 'a', configHash: 'ha', decision: 'allow' }),
      row({ serverName: 'b', configHash: 'hb', decision: 'allow' }),
    ]);
    expect(await listAllowedProjectMcpServerPairs(repository, REPO_SCOPE)).toEqual([
      { name: 'a', hash: 'ha' },
      { name: 'b', hash: 'hb' },
    ]);
  });

  it('excludes deny rows', async () => {
    const repository = fakeRepository([
      row({ serverName: 'a', configHash: 'ha', decision: 'allow' }),
      row({ serverName: 'b', configHash: 'hb', decision: 'deny' }),
    ]);
    expect(await listAllowedProjectMcpServerPairs(repository, REPO_SCOPE)).toEqual([{ name: 'a', hash: 'ha' }]);
  });

  it('returns an empty array when the scope has no rows (boundary value)', async () => {
    expect(await listAllowedProjectMcpServerPairs(fakeRepository([]), REPO_SCOPE)).toEqual([]);
  });

  it('returns an empty array when every row is a deny (boundary value)', async () => {
    const repository = fakeRepository([row({ decision: 'deny' })]);
    expect(await listAllowedProjectMcpServerPairs(repository, REPO_SCOPE)).toEqual([]);
  });

  it('works identically for a path scope (single-row, single-allow)', async () => {
    const pathScope: McpPermissionScope = { kind: 'path', locationPath: '/home/user/quick-project' };
    const repository = fakeRepository([row({ scope: pathScope, serverName: 'a', configHash: 'ha', decision: 'allow' })]);
    expect(await listAllowedProjectMcpServerPairs(repository, pathScope)).toEqual([{ name: 'a', hash: 'ha' }]);
  });
});

describe('resolveMcpPermissionScope', () => {
  // memfs-backed (this file's sibling `__tests__/` location, not one of
  // `test-trigger.md`'s three real-fs exception files) -- the actual OS-level
  // realpath/symlink resolution behavior this function delegates to is
  // already covered in the exempted real-fs file `memory-dir.test.ts` for
  // `resolveMemoryDirPath`'s identical realpath/path.resolve fallback shape;
  // these tests only need to prove OUR function calls through to `realpath`
  // and falls back correctly, which memfs's own realpath implementation
  // exercises faithfully for a plain existing-directory / nonexistent-path
  // pair (no symlink needed to distinguish those two branches).
  beforeEach(() => {
    setupMemfs({ '/test/quick-project': null });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('worktree session -> repository scope', async () => {
    const scope = await resolveMcpPermissionScope({ type: 'worktree', repositoryId: 'repo-1' });
    expect(scope).toEqual({ kind: 'repository', repositoryId: 'repo-1' });
  });

  it('quick session with a real existing cwd -> path scope at the realpath', async () => {
    const scope = await resolveMcpPermissionScope({ type: 'quick', locationPath: '/test/quick-project' });
    expect(scope).toEqual({ kind: 'path', locationPath: '/test/quick-project' });
  });

  it('quick session with a nonexistent cwd falls back to path.resolve(cwd) directly (boundary: ENOENT)', async () => {
    const scope = await resolveMcpPermissionScope({ type: 'quick', locationPath: '/no/such/quick-project' });
    expect(scope).toEqual({ kind: 'path', locationPath: path.resolve('/no/such/quick-project') });
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
