/**
 * Regression test for Issue #800: the git-diff base spec must be re-resolved on
 * every diff computation, not frozen to a hash at session creation.
 *
 * Symptom: after a feature branch absorbs upstream commits (merge of main),
 * the frozen merge-base hash makes those upstream commits show up as
 * "unexpected" file diffs — diverging from GitHub's three-dot PR view.
 *
 * This test drives the production `resolveBaseSpec` / `getDiffData` against a
 * REAL temp git repository. Because the `../lib/git.js` module is mocked
 * process-globally (mock-git-helper.ts) and that mock cannot be reliably undone
 * mid-process, we configure the SAME shared `mockGit` to delegate to the real
 * git CLI against the temp repo. This exercises the genuine production code path
 * deterministically and is immune to cross-file mock ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { MERGE_BASE_REF_PREFIX } from '@agent-console/shared';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  resolveBaseSpec,
  getDiffData,
} from '../git-diff-service.js';

/** Run a git command against `cwd`, returning trimmed stdout (throws on failure). */
async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout.trim();
}

/** Run a git command, returning null on failure (mirrors gitSafe). */
async function gitSafeReal(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await Bun.spawn(['mkdir', '-p', tmpDir]).exited;
  return tmpDir;
}

async function removeTempDir(dir: string): Promise<void> {
  await Bun.spawn(['rm', '-rf', dir]).exited;
}

/**
 * Wire the shared git mock to delegate to the real git CLI for the functions
 * `resolveBaseSpec` and `getDiffData` depend on. The cwd argument carries the
 * actual repo path through.
 */
function wireRealGit(): void {
  resetGitMocks();

  mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  mockGit.gitRefExists.mockImplementation((ref: string, cwd: string) =>
    gitSafeReal(['rev-parse', '--verify', ref], cwd).then((r) => r !== null)
  );
  mockGit.gitSafe.mockImplementation((args: string[], cwd: string) =>
    gitSafeReal(args, cwd)
  );
  mockGit.getMergeBaseSafe.mockImplementation((ref1: string, ref2: string, cwd: string) =>
    gitSafeReal(['merge-base', ref1, ref2], cwd)
  );

  // getDiffData dependencies
  mockGit.getDiff.mockImplementation((baseRef: string, targetRef: string | undefined, cwd: string) =>
    targetRef
      ? git(['diff', baseRef, targetRef], cwd)
      : git(['diff', baseRef], cwd)
  );
  mockGit.getDiffNumstat.mockImplementation((baseRef: string, targetRef: string | undefined, cwd: string) =>
    targetRef
      ? git(['diff', '--numstat', baseRef, targetRef], cwd)
      : git(['diff', '--numstat', baseRef], cwd)
  );
  mockGit.getStatusPorcelain.mockImplementation((cwd: string) =>
    git(['status', '--porcelain', '-uall'], cwd)
  );
  mockGit.getUntrackedFiles.mockImplementation((cwd: string) =>
    git(['ls-files', '--others', '--exclude-standard'], cwd).then((out) =>
      out.split('\n').filter(Boolean)
    )
  );
}

describe('Issue #800: git-diff base spec re-resolution (real repo)', () => {
  let repo: string;

  beforeEach(async () => {
    wireRealGit();
    repo = await createTempDir('git-diff-800-');
    await git(['init', '-b', 'main'], repo);
    await git(['config', 'user.email', 'test@example.com'], repo);
    await git(['config', 'user.name', 'Test'], repo);

    // Initial commit on main
    await Bun.write(path.join(repo, 'base.txt'), 'base\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'initial commit'], repo);
  });

  afterEach(async () => {
    await removeTempDir(repo);
    resetGitMocks();
  });

  it('does NOT include an upstream-only file in the diff after the feature branch merges main', async () => {
    // Feature branch off main with its own change
    await git(['checkout', '-b', 'feature'], repo);
    await Bun.write(path.join(repo, 'feature.txt'), 'feature change\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'feature commit'], repo);

    // Back on main: add an upstream-only commit
    await git(['checkout', 'main'], repo);
    await Bun.write(path.join(repo, 'upstream.txt'), 'upstream only\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'upstream commit'], repo);

    // Back on the feature branch — this is the persisted base spec
    await git(['checkout', 'feature'], repo);
    const spec = `${MERGE_BASE_REF_PREFIX}main`;

    // Diff #1: resolves merge-base(main, HEAD) — should contain the feature
    // change but NOT the upstream-only file.
    const resolved1 = await resolveBaseSpec(spec, repo);
    expect(resolved1).not.toBeNull();
    const diff1 = await getDiffData(repo, resolved1!);
    const paths1 = diff1.summary.files.map((f) => f.path);
    expect(paths1).toContain('feature.txt');
    expect(paths1).not.toContain('upstream.txt');

    // Merge main into feature (absorb the upstream commit, no conflicts)
    await git(['merge', 'main', '--no-edit'], repo);

    // Diff #2: SAME spec, re-resolved → merge-base moves forward to include the
    // upstream commit, so upstream.txt must NOT appear in the diff.
    const resolved2 = await resolveBaseSpec(spec, repo);
    expect(resolved2).not.toBeNull();
    // The merge-base must have advanced (re-resolution actually happened).
    expect(resolved2).not.toBe(resolved1);
    const diff2 = await getDiffData(repo, resolved2!);
    const paths2 = diff2.summary.files.map((f) => f.path);
    expect(paths2).toContain('feature.txt');
    // CORE REGRESSION ASSERTION: with the old frozen-hash behavior diff2 WOULD
    // include upstream.txt.
    expect(paths2).not.toContain('upstream.txt');
  });

  it('yields an empty diff when the branch has no own changes (no upstream noise)', async () => {
    // A branch identical to main: merge-base is HEAD, diff must be empty.
    await git(['checkout', '-b', 'no-changes'], repo);
    const spec = `${MERGE_BASE_REF_PREFIX}main`;
    const resolved = await resolveBaseSpec(spec, repo);
    expect(resolved).not.toBeNull();
    const diff = await getDiffData(repo, resolved!);
    expect(diff.summary.files).toHaveLength(0);
  });
});
