import { describe, it, expect } from 'bun:test';
import { buildSessionDataCleanupTargets } from '../session-data-cleanup-candidates.js';
import { computeSessionDataBaseDir } from '../../lib/session-data-path.js';

const CONFIG_DIR = '/test/config';

describe('buildSessionDataCleanupTargets (Issue #1301)', () => {
  it('dedups identical canonical/basename candidates into a single existing target', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      deriveSlug: async () => 'repo-1',
      pathExists: async () => true,
    });

    expect(targets).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-1')]);
  });

  it('returns only the target repository\'s candidate slugs, not an unrelated sibling repository\'s slug', async () => {
    const targetsForRepoA = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-a',
      repoPath: '/source/repos/owner/repo-a',
      deriveSlug: async () => 'repo-a',
      pathExists: async () => true,
    });

    const repoBDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-b');
    expect(targetsForRepoA).not.toContain(repoBDir);
    expect(targetsForRepoA).toEqual([computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'repo-a')]);
  });

  it('returns exactly the canonical and basename directories when they differ, probing each once', async () => {
    const seenPaths: string[] = [];
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/basename-slug',
      deriveSlug: async () => 'canonical-slug',
      pathExists: async (p) => {
        seenPaths.push(p);
        return true;
      },
    });

    expect(targets.sort()).toEqual(
      [
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'canonical-slug'),
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'basename-slug'),
      ].sort(),
    );
    // Each candidate is probed exactly once (no duplicate existence checks).
    expect(seenPaths.length).toBe(2);
  });

  it('never addresses a directory by the repository display name (a directory existing at repositories/<other name> is not returned or probed)', async () => {
    // Every path "exists", including one named like a renamed display label and
    // one that belongs to a different repository. Only the canonical and
    // basename targets may come back: the display name is not an input.
    const probed: string[] = [];
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/basename-slug',
      deriveSlug: async () => 'owner/canonical-repo',
      pathExists: async (p) => {
        probed.push(p);
        return true;
      },
    });

    const displayLabelDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'renamed-label');
    const otherRepoDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'owner/another-repo');
    expect(targets).not.toContain(displayLabelDir);
    expect(targets).not.toContain(otherRepoDir);
    expect(probed).not.toContain(displayLabelDir);
    expect(probed).not.toContain(otherRepoDir);
    expect(targets.sort()).toEqual(
      [
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'owner/canonical-repo'),
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'basename-slug'),
      ].sort(),
    );
  });

  it('omits candidates that fail the existence check', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      deriveSlug: async () => 'repo-1',
      pathExists: async () => false,
    });

    expect(targets).toEqual([]);
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
      // the hostile candidate through the injected `deriveSlug` instead,
      // which is passed through verbatim. Production `deriveRepositorySlug`
      // itself never returns a hostile value (it validates via
      // `isValidSlug` before returning); this test exercises
      // `buildSessionDataCleanupTargets`'s own defense-in-depth handling,
      // independent of what the derivation returns.
      repoPath: '/source/repos/owner/repo-1',
      deriveSlug: async () => '../etc',
      pathExists: async () => true,
    });

    // The hostile '../etc' candidate is silently skipped (logged, not
    // thrown); the remaining candidate (the basename, 'repo-1') is the
    // one valid, existing target.
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
        deriveSlug: async () => '../etc',
        pathExists: async () => true,
      }),
    ).resolves.toEqual([]);
  });

  // ===========================================================================
  // T4/T5: structural-coupling lock. Proves the coupling to the repository
  // slug is a CALL to the injected derivation, not a re-derivation -- so a
  // future change to what that derivation returns (Issue #1300) keeps this
  // test correct without modification.
  //
  // Updated for Issue #1300's new single writer: the injected function was
  // renamed from `getRepositorySlug(id)` to `deriveSlug(repoPath, fallback)`
  // (mirroring `deriveRepositorySlug`'s signature in `lib/git.ts`), and the
  // production default changed from `RepositoryManager.getRepositorySlug`
  // to `deriveRepositorySlug` directly. The assertion is UNCHANGED: a
  // sentinel value returned by the injected function must land in the
  // target set. This is the structural-coupling receipt for the new writer,
  // not a weakening of the original #1301 lock.
  // ===========================================================================

  it('is driven by a call to the injected deriveSlug, not an independent re-derivation of the canonical slug', async () => {
    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/basename-not-sentinel',
      deriveSlug: async () => 'sentinel-canonical-slug',
      pathExists: async (p) => p.includes('sentinel-canonical-slug'),
    });

    expect(targets).toEqual([
      computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'sentinel-canonical-slug'),
    ]);
  });

  it('forwards repoPath and the basename fallback verbatim to deriveSlug', async () => {
    const calls: Array<{ repoPath: string; fallback: string }> = [];
    await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/source/repos/owner/repo-1',
      deriveSlug: async (repoPath, fallback) => {
        calls.push({ repoPath, fallback });
        return 'repo-1';
      },
      pathExists: async () => true,
    });

    expect(calls).toEqual([{ repoPath: '/source/repos/owner/repo-1', fallback: 'repo-1' }]);
  });

  it('skips a candidate whose directory is in claimedDirs, without probing it, and keeps the unclaimed one', async () => {
    const probed: string[] = [];
    const canonicalDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'org/foo');
    const flatDir = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo');

    const targets = await buildSessionDataCleanupTargets({
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/x/foo',
      deriveSlug: async () => 'org/foo',
      pathExists: async (p) => {
        probed.push(p);
        return true;
      },
      claimedDirs: new Set([flatDir]),
    });

    expect(targets).toEqual([canonicalDir]);
    expect(probed).toEqual([canonicalDir]);
  });

  it('returns both candidates when claimedDirs is empty or absent (positive control)', async () => {
    const params = {
      configDir: CONFIG_DIR,
      repositoryId: 'repo-1',
      repoPath: '/x/foo',
      deriveSlug: async () => 'org/foo',
      pathExists: async () => true,
    };
    const expected = [
      computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'org/foo'),
      computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo'),
    ];
    expect(await buildSessionDataCleanupTargets(params)).toEqual(expected);
    expect(await buildSessionDataCleanupTargets({ ...params, claimedDirs: new Set() })).toEqual(expected);
  });
});
