import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { findClaimedRepositoryDirs, repositoryDirFromWorktreePath } from '../repository-dir-claims.js';

const HOME = '/test/claims-home';
const REPOS = path.join(HOME, 'repositories');

describe('repositoryDirFromWorktreePath', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  beforeEach(() => {
    process.env.AGENT_CONSOLE_HOME = HOME;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
    else process.env.AGENT_CONSOLE_HOME = originalHome;
  });

  it('maps the placement shape for an org/repo slug', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/org/old/worktrees/wt-001-x`)).toBe(`${REPOS}/org/old`);
  });

  it('maps the placement shape for a flat slug', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/flat/worktrees/wt-002-y`)).toBe(`${REPOS}/flat`);
  });

  it('returns null for a main checkout path outside repositoriesDir', () => {
    expect(repositoryDirFromWorktreePath('/home/dev/projects/foo')).toBeNull();
  });

  it('returns null for a worktree-shaped path outside repositoriesDir', () => {
    expect(repositoryDirFromWorktreePath('/elsewhere/org/old/worktrees/wt-001-x')).toBeNull();
  });

  it('returns null for a path directly under repositoriesDir without the worktrees segment', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/org/old`)).toBeNull();
    expect(repositoryDirFromWorktreePath(`${REPOS}/org/old/templates/x`)).toBeNull();
  });

  it('returns null for extra depth below the worktree segment', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/org/old/worktrees/wt-001-x/sub`)).toBeNull();
  });

  it('returns null for a path with a .. segment even when it normalizes into the shape', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/org/x/../old/worktrees/wt-001-x`)).toBeNull();
    expect(repositoryDirFromWorktreePath(`${REPOS}/../outside/worktrees/wt-001-x`)).toBeNull();
  });

  it('returns null for a placement-shaped path whose slug is invalid (too deep)', () => {
    expect(repositoryDirFromWorktreePath(`${REPOS}/a/b/c/worktrees/wt-001-x`)).toBeNull();
  });

  it('returns null for a relative path', () => {
    expect(repositoryDirFromWorktreePath('repositories/org/old/worktrees/wt-001-x')).toBeNull();
  });
});

describe('findClaimedRepositoryDirs', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  beforeEach(() => {
    process.env.AGENT_CONSOLE_HOME = HOME;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENT_CONSOLE_HOME;
    else process.env.AGENT_CONSOLE_HOME = originalHome;
  });

  const noRows = async () => [] as string[];
  const fallbackDerive = async (_p: string, fallback: string) => fallback;

  it('claims nothing when the repository is the only registered one', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [{ id: 'a', path: '/x/foo' }],
      listWorktreePaths: noRows,
      deriveSlug: async () => 'org/foo',
    });
    expect(claimed.size).toBe(0);
  });

  it('claims another repository\'s canonical slug directory', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listWorktreePaths: noRows,
      deriveSlug: async (p) => (p === '/y/bar' ? 'org/shared' : 'org/foo'),
    });
    expect(claimed.has(`${REPOS}/org/shared`)).toBe(true);
    expect(claimed.has(`${REPOS}/org/foo`)).toBe(false);
  });

  it('claims another repository\'s path basename directory', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/foo' },
      ],
      listWorktreePaths: noRows,
      deriveSlug: async (p) => (p === '/y/foo' ? 'org/other' : 'org/foo'),
    });
    expect(claimed.has(`${REPOS}/foo`)).toBe(true);
    expect(claimed.has(`${REPOS}/org/other`)).toBe(true);
  });

  it('claims a directory another repository holds a worktree row under, and ignores its non-placement rows', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listWorktreePaths: async (id) =>
        id === 'b' ? [`${REPOS}/org/legacy/worktrees/wt-001-x`, '/y/bar'] : [`${REPOS}/org/mine/worktrees/wt-001-z`],
      deriveSlug: fallbackDerive,
    });
    expect(claimed.has(`${REPOS}/org/legacy`)).toBe(true);
    expect(claimed.has(`${REPOS}/org/mine`)).toBe(false);
    expect(claimed.has('/y/bar')).toBe(false);
  });

  it('a derivation failure for another repository makes it claim its basename only and does not abort', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listWorktreePaths: async (id) => (id === 'b' ? [`${REPOS}/org/legacy/worktrees/wt-001-x`] : []),
      deriveSlug: async () => {
        throw new Error('git failed');
      },
    });
    expect([...claimed].sort()).toEqual([`${REPOS}/bar`, `${REPOS}/org/legacy`].sort());
  });
});
