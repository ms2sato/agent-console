import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import { findClaimedRepositoryDirs, isProtectedByClaim, repositoryDirFromWorktreePath } from '../repository-dir-claims.js';
import type { RepositoryDirClaims } from '../repository-dir-claims.js';

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

const claimsOf = (subtree: string[], point: string[] = []): RepositoryDirClaims => ({
  subtree: new Set(subtree),
  point: new Set(point),
});
const allOf = (c: RepositoryDirClaims): Set<string> => new Set([...c.subtree, ...c.point]);

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
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: async () => 'org/foo',
    });
    expect(allOf(claimed).size).toBe(0);
  });

  it('claims another repository\'s canonical slug directory', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: async (p) => (p === '/y/bar' ? 'org/shared' : 'org/foo'),
    });
    expect(allOf(claimed).has(`${REPOS}/org/shared`)).toBe(true);
    expect(allOf(claimed).has(`${REPOS}/org/foo`)).toBe(false);
  });

  it('claims another repository\'s path basename directory', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/foo' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: async (p) => (p === '/y/foo' ? 'org/other' : 'org/foo'),
    });
    expect(allOf(claimed).has(`${REPOS}/foo`)).toBe(true);
    expect(allOf(claimed).has(`${REPOS}/org/other`)).toBe(true);
  });

  it('claims a directory another repository holds a worktree row under, and ignores its non-placement rows', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: async (id) =>
        id === 'b' ? [`${REPOS}/org/legacy/worktrees/wt-001-x`, '/y/bar'] : [`${REPOS}/org/mine/worktrees/wt-001-z`],
      deriveSlug: fallbackDerive,
    });
    expect(allOf(claimed).has(`${REPOS}/org/legacy`)).toBe(true);
    expect(allOf(claimed).has(`${REPOS}/org/mine`)).toBe(false);
    // The main-checkout row adds nothing as a worktree-derived directory; '/y/bar' is
    // claimed only as b's own checkout path (claim d), never through its row.
    expect(allOf(claimed).has('/y/bar')).toBe(true);
    expect([...allOf(claimed)].filter((d) => d.startsWith(REPOS)).sort()).toEqual([`${REPOS}/bar`, `${REPOS}/org/legacy`].sort());
  });

  it('a derivation failure for another repository keeps its checkout path, basename and worktree-row directories and does not abort', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: async (id) => (id === 'b' ? [`${REPOS}/org/legacy/worktrees/wt-001-x`] : []),
      deriveSlug: async () => {
        throw new Error('git failed');
      },
    });
    expect([...allOf(claimed)].sort()).toEqual(['/y/bar', `${REPOS}/bar`, `${REPOS}/org/legacy`].sort());
  });

  // Claim (d). Reach (measured by deleting the `claimed.add(path.resolve(other.path))` line):
  // the four tests below fail, plus the two older worktree-row / derivation-failure tests
  // above, whose expected sets now include the checkout path.
  it('claims another repository\'s checkout path, which protects an ancestor directory but not an unrelated one', async () => {
    const checkout = `${REPOS}/org/old/worktrees/wt-a`;
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: checkout },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: async (p) => (p === checkout ? 'org/new' : 'org/foo'),
    });
    expect(allOf(claimed).has(checkout)).toBe(true);
    expect(isProtectedByClaim(`${REPOS}/org/old`, claimed)).toBe(true);
    // Control: a directory that holds no claimed checkout is not protected.
    expect(isProtectedByClaim(`${REPOS}/org/other`, claimed)).toBe(false);
  });

  it('still claims the checkout path when the slug derivation throws', async () => {
    const checkout = `${REPOS}/org/old/worktrees/wt-a`;
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: checkout },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: async () => {
        throw new Error('git failed');
      },
    });
    expect(allOf(claimed).has(checkout)).toBe(true);
    // Control: the derivation failure did degrade to the basename claim.
    expect(allOf(claimed).has(`${REPOS}/wt-a`)).toBe(true);
  });

  it('claims the resolved form of a checkout path given with a .. segment', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: `${REPOS}/org/x/../old/worktrees/wt-a` },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: fallbackDerive,
    });
    expect(allOf(claimed).has(`${REPOS}/org/old/worktrees/wt-a`)).toBe(true);
    expect(allOf(claimed).has(`${REPOS}/org/x/../old/worktrees/wt-a`)).toBe(false);
  });

  it('does not claim the checkout path of the repository being unregistered', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: `${REPOS}/org/mine/worktrees/wt-a` },
        { id: 'b', path: '/y/bar' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: fallbackDerive,
    });
    expect(allOf(claimed).has(`${REPOS}/org/mine/worktrees/wt-a`)).toBe(false);
    // Control: the other registration's checkout is claimed.
    expect(allOf(claimed).has('/y/bar')).toBe(true);
  });

  it('puts canonical and worktree-row directories in subtree, basename and checkout in point', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/x' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: async (id) => (id === 'b' ? [`${REPOS}/org/old/worktrees/wt-001-x`] : []),
      deriveSlug: async (p) => (p === '/y/x' ? 'org/x' : 'org/foo'),
    });
    expect([...claimed.subtree].sort()).toEqual([`${REPOS}/org/x`, `${REPOS}/org/old`].sort());
    expect([...claimed.point].sort()).toEqual([`${REPOS}/x`, '/y/x'].sort());
  });

  it('puts the basename directory in subtree when the other repository has no remote (canonical equals basename)', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/x' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: noRows,
      deriveSlug: fallbackDerive,
    });
    expect(claimed.subtree.has(`${REPOS}/x`)).toBe(true);
    expect(claimed.point.has(`${REPOS}/x`)).toBe(true);
  });

  it('a derivation failure leaves subtree with only worktree-row directories and point with basename and checkout', async () => {
    const claimed = await findClaimedRepositoryDirs({
      repo: { id: 'a' },
      registeredRepositories: [
        { id: 'a', path: '/x/foo' },
        { id: 'b', path: '/y/bar' },
      ],
      listSessionDataSlugs: noRows,
      listWorktreePaths: async (id) => (id === 'b' ? [`${REPOS}/org/legacy/worktrees/wt-001-x`] : []),
      deriveSlug: async () => {
        throw new Error('git failed');
      },
    });
    expect([...claimed.subtree]).toEqual([`${REPOS}/org/legacy`]);
    expect([...claimed.point].sort()).toEqual([`${REPOS}/bar`, '/y/bar'].sort());
  });

  // Claim (e). Reach (measured, see the PR): deleting the session-slug loop fails
  // the four tests below that expect its directories; putting them in `point`
  // instead of `subtree` fails the shape assertion of the first test.
  describe('claim (e): session-row slugs', () => {
    const two = [
      { id: 'a', path: '/x/foo' },
      { id: 'b', path: '/y/x' },
    ];

    it('puts each distinct valid session slug directory in subtree once, next to canonical and basename', async () => {
      const claimed = await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: two,
        listWorktreePaths: noRows,
        listSessionDataSlugs: async (id) => (id === 'b' ? ['x', 'x', 'org/prev'] : []),
        deriveSlug: async (p) => (p === '/y/x' ? 'org/x' : 'org/foo'),
      });
      expect([...claimed.subtree].sort()).toEqual([`${REPOS}/org/x`, `${REPOS}/x`, `${REPOS}/org/prev`].sort());
      expect([...claimed.point].sort()).toEqual([`${REPOS}/x`, '/y/x'].sort());
      // The basename directory is in point only by its own claim (b); the (e) one is subtree.
      expect(isProtectedByClaim(`${REPOS}/x/messages`, claimed)).toBe(true);
      // Control: without the session rows the basename descendant is not protected.
      const control = await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: two,
        listWorktreePaths: noRows,
        listSessionDataSlugs: noRows,
        deriveSlug: async (p) => (p === '/y/x' ? 'org/x' : 'org/foo'),
      });
      expect(isProtectedByClaim(`${REPOS}/x/messages`, control)).toBe(false);
    });

    it('adds nothing for an invalid slug or an empty list', async () => {
      const claimed = await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: two,
        listWorktreePaths: noRows,
        listSessionDataSlugs: async (id) => (id === 'b' ? ['../escape', 'a/b/c', ''] : []),
        deriveSlug: fallbackDerive,
      });
      expect([...claimed.subtree]).toEqual([`${REPOS}/x`]);
      // Control: a valid slug in the same list is claimed.
      const withValid = await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: two,
        listWorktreePaths: noRows,
        listSessionDataSlugs: async () => ['../escape', 'org/prev'],
        deriveSlug: fallbackDerive,
      });
      expect(withValid.subtree.has(`${REPOS}/org/prev`)).toBe(true);
      expect(withValid.subtree.has(`${REPOS}/../escape`)).toBe(false);
    });

    it('keeps the session-slug directories when the slug derivation throws', async () => {
      const claimed = await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: two,
        listWorktreePaths: noRows,
        listSessionDataSlugs: async (id) => (id === 'b' ? ['org/prev'] : []),
        deriveSlug: async () => {
          throw new Error('git failed');
        },
      });
      expect(claimed.subtree.has(`${REPOS}/org/prev`)).toBe(true);
      // Control: the derivation failure did degrade (no canonical claim; basename is point-only).
      expect([...claimed.subtree]).toEqual([`${REPOS}/org/prev`]);
    });

    it('never asks for the session slugs of the repository being unregistered', async () => {
      const asked: string[] = [];
      await findClaimedRepositoryDirs({
        repo: { id: 'a' },
        registeredRepositories: [...two, { id: 'c', path: '/z/c' }],
        listWorktreePaths: noRows,
        listSessionDataSlugs: async (id) => {
          asked.push(id);
          return [];
        },
        deriveSlug: fallbackDerive,
      });
      expect(asked.sort()).toEqual(['b', 'c']);
    });
  });
});

describe('isProtectedByClaim', () => {
  it('protects a directory equal to a claimed one, for each kind', () => {
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([`${REPOS}/acme`]))).toBe(true);
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([], [`${REPOS}/acme`]))).toBe(true);
  });

  it('protects an ancestor of a claimed directory, for each kind', () => {
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([`${REPOS}/acme/project`]))).toBe(true);
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([], [`${REPOS}/acme/project`]))).toBe(true);
  });

  it('does not protect a sibling that only shares a name prefix (segment comparison, ancestor direction)', () => {
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([`${REPOS}/acme-old`], [`${REPOS}/acme-old`]))).toBe(false);
  });

  it('does not protect a directory that only shares a name prefix with a subtree claim (descendant direction)', () => {
    expect(isProtectedByClaim(`${REPOS}/acme-old/y`, claimsOf([`${REPOS}/acme`]))).toBe(false);
  });

  it('protects a descendant of a subtree claim', () => {
    expect(isProtectedByClaim(`${REPOS}/x/y`, claimsOf([`${REPOS}/x`]))).toBe(true);
  });

  it('does not protect a descendant of a point claim', () => {
    expect(isProtectedByClaim(`${REPOS}/x/y`, claimsOf([], [`${REPOS}/x`]))).toBe(false);
    expect(isProtectedByClaim(`${REPOS}/x/y`, claimsOf([], ['/']))).toBe(false);
  });

  it('protects nothing when both sets are empty', () => {
    expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([]))).toBe(false);
  });

  describe('relative forms are compared resolved', () => {
    const rel = (abs: string): string => path.relative(process.cwd(), abs);

    it('protects a relative dir equal to an absolute claim', () => {
      expect(isProtectedByClaim(rel(`${REPOS}/acme`), claimsOf([`${REPOS}/acme`]))).toBe(true);
    });

    it('protects a relative dir that is the ancestor of an absolute claim', () => {
      expect(isProtectedByClaim(rel(`${REPOS}/acme`), claimsOf([`${REPOS}/acme/project`]))).toBe(true);
    });

    it('protects an absolute dir inside a relative subtree claim', () => {
      expect(isProtectedByClaim(`${REPOS}/acme/project`, claimsOf([rel(`${REPOS}/acme`)]))).toBe(true);
    });

    it('protects an absolute dir equal to a relative claim', () => {
      expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([rel(`${REPOS}/acme`)]))).toBe(true);
    });

    it('protects an absolute dir that is the ancestor of a relative claim', () => {
      expect(isProtectedByClaim(`${REPOS}/acme`, claimsOf([rel(`${REPOS}/acme/project`)]))).toBe(true);
    });

    it('does not protect a relative dir against an unrelated absolute claim', () => {
      expect(isProtectedByClaim(rel(`${REPOS}/acme`), claimsOf([`${REPOS}/other`]))).toBe(false);
    });
  });
});
