import { describe, it, expect } from 'bun:test';
import { listAllowedProjectMcpServerPairs } from '../mcp-server-permissions.js';
import type {
  McpServerPermissionRepository,
  McpServerPermissionRow,
} from '../../repositories/mcp-server-permission-repository.js';

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
