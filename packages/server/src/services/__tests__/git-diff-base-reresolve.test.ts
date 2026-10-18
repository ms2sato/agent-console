/**
 * Regression test for Issue #800: the git-diff base spec must be re-resolved on
 * every diff computation, not frozen to a hash at session creation.
 *
 * Symptom: after a feature branch absorbs upstream commits (merge of main),
 * the frozen merge-base hash makes those upstream commits show up as
 * "unexpected" file diffs — diverging from GitHub's three-dot PR view.
 *
 * This test drives the production `resolveBaseSpec` / `getDiffData` -- and the
 * production `lib/git.ts` underneath them, nothing mocked -- against a REAL temp
 * git repository. It must not import `mock-git-helper.ts`: `mock.module` is
 * process-global, so that import would replace `lib/git.js` for every later file
 * in the shared real-fs process (`real-fs-invocation.test.ts` (iv) enforces
 * this). The production git calls inherit the process environment, so the
 * scratch repo's throwaway global config is exported into `process.env` for
 * the duration of each test.
 *
 * The repo is created via `createScratchGitRepo` (scratch-git.ts) rather than
 * a hand-rolled temp dir, so every commit made below runs under a throwaway
 * global git config instead of the operator's own -- a real host config with
 * commit signing enabled otherwise fails every commit here before the code
 * under test is ever reached (see `os-environment-coupling.md`). Because a
 * real `git` subprocess needs directories memfs cannot make visible to it,
 * this file runs in `packages/server`'s second (real-fs) `bun test`
 * invocation (`package.json`) and calls `assertRealFs` before any other fs
 * call, per `testing.md`'s real-fs test placement rule.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MERGE_BASE_REF_PREFIX } from '@agent-console/shared';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import { createScratchGitRepo, type ScratchGitRepo } from '../../__tests__/utils/scratch-git.js';
import {
  resolveBaseSpec,
  getDiffData,
} from '../git-diff-service.js';

let repo: ScratchGitRepo;
/** Prior values of the env keys the test overrides (`undefined` = was unset). */
let savedEnv: Record<string, string | undefined> = {};

/** Run a git command against `cwd`, returning trimmed stdout (throws on failure). */
async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: repo.env,
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout.trim();
}

describe('Issue #800: git-diff base spec re-resolution (real repo)', () => {
  let scratchParent: string;

  beforeAll(async () => {
    await assertRealFs('git-diff-base-reresolve.test.ts setup');
    scratchParent = await mkdtemp(path.join(os.tmpdir(), 'git-diff-800-parent-'));
  });

  afterAll(async () => {
    await rm(scratchParent, { recursive: true, force: true });
  });

  beforeEach(async () => {
    repo = await createScratchGitRepo({ parentDir: scratchParent, initialCommit: false });
    // The production lib/git.ts spawns git with the process env: point it at the scratch config.
    savedEnv = {};
    for (const [key, value] of Object.entries(repo.env)) {
      if (process.env[key] !== value) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
      }
    }

    // Initial commit on main
    await Bun.write(path.join(repo.dir, 'base.txt'), 'base\n');
    await git(['add', '.'], repo.dir);
    await git(['commit', '-m', 'initial commit'], repo.dir);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await repo.cleanup();
  });

  it('does NOT include an upstream-only file in the diff after the feature branch merges main', async () => {
    // Feature branch off main with its own change
    await git(['checkout', '-b', 'feature'], repo.dir);
    await Bun.write(path.join(repo.dir, 'feature.txt'), 'feature change\n');
    await git(['add', '.'], repo.dir);
    await git(['commit', '-m', 'feature commit'], repo.dir);

    // Back on main: add an upstream-only commit
    await git(['checkout', 'main'], repo.dir);
    await Bun.write(path.join(repo.dir, 'upstream.txt'), 'upstream only\n');
    await git(['add', '.'], repo.dir);
    await git(['commit', '-m', 'upstream commit'], repo.dir);

    // Back on the feature branch — this is the persisted base spec
    await git(['checkout', 'feature'], repo.dir);
    const spec = `${MERGE_BASE_REF_PREFIX}main`;

    // Diff #1: resolves merge-base(main, HEAD) — should contain the feature
    // change but NOT the upstream-only file.
    const resolved1 = await resolveBaseSpec(spec, repo.dir, null);
    expect(resolved1).not.toBeNull();
    const diff1 = await getDiffData(repo.dir, resolved1!, null);
    const paths1 = diff1.summary.files.map((f) => f.path);
    expect(paths1).toContain('feature.txt');
    expect(paths1).not.toContain('upstream.txt');

    // Merge main into feature (absorb the upstream commit, no conflicts)
    await git(['merge', 'main', '--no-edit'], repo.dir);

    // Diff #2: SAME spec, re-resolved → merge-base moves forward to include the
    // upstream commit, so upstream.txt must NOT appear in the diff.
    const resolved2 = await resolveBaseSpec(spec, repo.dir, null);
    expect(resolved2).not.toBeNull();
    // The merge-base must have advanced (re-resolution actually happened).
    expect(resolved2).not.toBe(resolved1);
    const diff2 = await getDiffData(repo.dir, resolved2!, null);
    const paths2 = diff2.summary.files.map((f) => f.path);
    expect(paths2).toContain('feature.txt');
    // CORE REGRESSION ASSERTION: with the old frozen-hash behavior diff2 WOULD
    // include upstream.txt.
    expect(paths2).not.toContain('upstream.txt');
  });

  it('yields an empty diff when the branch has no own changes (no upstream noise)', async () => {
    // A branch identical to main: merge-base is HEAD, diff must be empty.
    await git(['checkout', '-b', 'no-changes'], repo.dir);
    const spec = `${MERGE_BASE_REF_PREFIX}main`;
    const resolved = await resolveBaseSpec(spec, repo.dir, null);
    expect(resolved).not.toBeNull();
    const diff = await getDiffData(repo.dir, resolved!, null);
    expect(diff.summary.files).toHaveLength(0);
  });
});
