import { describe, it, expect } from 'bun:test';
import { buildSessionDataCleanupTargets } from '../session-data-cleanup-candidates.js';
import { computeSessionDataBaseDir } from '../../lib/session-data-path.js';

const CONFIG_DIR = '/test/config';

describe('buildSessionDataCleanupTargets (Issue #1301)', () => {
  it('dedups identical canonical/basename/repoName candidates into a single existing target', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      repoName: 'repo-1',
      getRepositorySlug: () => 'repo-1',
      pathExists: async () => true,
    });

    expect(targets).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-1')]);
  });

  it('returns only the target repository\'s candidate slugs, not an unrelated sibling repository\'s slug', async () => {
    const targetsForRepoA = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-a',
      repoPath: '/source/repos/owner/repo-a',
      repoName: 'repo-a',
      getRepositorySlug: () => 'repo-a',
      pathExists: async () => true,
    });

    const repoBDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-b');
    expect(targetsForRepoA).not.toContain(repoBDir);
    expect(targetsForRepoA).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-a')]);
  });

  it('returns three distinct candidate dirs when the canonical slug, basename, and repoName all differ', async () => {
    const seenPaths: string[] = [];
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/basename-slug',
      repoName: 'reponame-slug',
      getRepositorySlug: () => 'canonical-slug',
      pathExists: async (p) => {
        seenPaths.push(p);
        return true;
      },
    });

    expect(targets.sort()).toEqual(
      [
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'canonical-slug'),
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'basename-slug'),
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'reponame-slug'),
      ].sort(),
    );
    // Each candidate is probed exactly once (no duplicate existence checks).
    expect(seenPaths.length).toBe(3);
  });

  it('omits candidates that fail the existence check', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      repoName: 'repo-1',
      getRepositorySlug: () => 'repo-1',
      pathExists: async () => false,
    });

    expect(targets).toEqual([]);
  });

  it('omits the canonical-slug candidate entirely when getRepositorySlug returns undefined (unregistered repo)', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      repoName: 'repo-1',
      getRepositorySlug: () => undefined,
      pathExists: async () => true,
    });

    // basename(repoPath) === repoName === 'repo-1' here, so the only
    // resulting target is the deduped 'repo-1' candidate -- proving the
    // canonical slug was not silently coerced to some other value.
    expect(targets).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-1')]);
  });

  // ===========================================================================
  // T3: containment + validator-rejection. A hostile slug must never be
  // hand-joined into a path -- `computeSessionDataBaseDir` is the exclusive,
  // validating single writer, and a rejected candidate must not abort the
  // other, valid candidates in the same call (per-candidate isolation).
  // ===========================================================================

  it('skips a path-traversal candidate slug without throwing, and still returns the other valid candidates', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      // basename('/source/repos/owner/../etc') resolves to 'etc' via
      // path.basename (no traversal semantics at that layer), so we drive
      // the hostile candidate through the canonical-slug callback instead,
      // which is passed through verbatim.
      repoPath: '/source/repos/owner/repo-1',
      repoName: 'repo-1',
      getRepositorySlug: () => '../etc',
      pathExists: async () => true,
    });

    // The hostile '../etc' candidate is silently skipped (logged, not
    // thrown); the other two candidates (basename + repoName, both
    // 'repo-1') dedup to the one valid, existing target.
    expect(targets).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-1')]);
  });

  it('does not throw when every candidate slug is invalid, returning an empty target list', async () => {
    await expect(
      buildSessionDataCleanupTargets({
        configDir: CONFIG_DIR,
        repositoryId: 'repo-1',
        // path.basename('/source/repos/..') === '..' -- an invalid slug
        // segment, not a resolved traversal (path.basename does not
        // normalize '..' away).
        repoPath: '/source/repos/..',
        repoName: '..',
        getRepositorySlug: () => '../etc',
        pathExists: async () => true,
      }),
    ).resolves.toEqual([]);
  });

  // ===========================================================================
  // T4: structural-coupling lock. Proves the coupling to the repository slug
  // is a CALL to `getRepositorySlug`, not a re-derivation -- so a future
  // change to what that accessor returns (Issue #1300) keeps this test
  // correct without modification.
  // ===========================================================================

  it('is driven by a call to getRepositorySlug, not an independent re-derivation of the canonical slug', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/basename-not-sentinel',
      repoName: 'reponame-not-sentinel',
      getRepositorySlug: () => 'sentinel-canonical-slug',
      pathExists: async (p) => p.includes('sentinel-canonical-slug'),
    });

    expect(targets).toEqual([
      computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'sentinel-canonical-slug'),
    ]);
  });
});
