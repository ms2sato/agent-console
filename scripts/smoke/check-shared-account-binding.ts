#!/usr/bin/env bun
/**
 * Shipping-path smoke for shared-account Release 2: a DB-backed shared
 * account SET plus a per-repository BINDING actually drive session-creation
 * PTY spawn identity (Issue #1842 item 9).
 *
 * Boots a disposable multi-user `AppContext` (`createTestContext`, in-memory
 * SQLite) with a real `/api` router mounted (`packages/server/src/routes/
 * api.ts`'s `api` export), drives every step through that REAL router via
 * `app.request(...)`, and against two real target OS users:
 *
 *   - registers both as shared accounts (`POST /api/shared-accounts`)
 *   - binds repository R1 -> account A, R2 -> account B
 *     (`PATCH /api/repositories/:id`)
 *   - creates a shared worktree session on each repository
 *     (`POST /api/repositories/:id/worktrees`)
 *   - asserts each session's agent-worker PTY actually runs as its OWN
 *     bound account (real OS-level identity, not merely a `createdBy` DB
 *     column)
 *   - asserts a quick session can never be `shared: true` (400,
 *     unconditional)
 *   - rebinds R1 -> B, then asserts the EXISTING R1 session (created
 *     against the OLD binding, before the rebind) is STILL operable by a
 *     caller who is neither its owner nor the account it is now bound to --
 *     proving membership of the shared-account SET (not the CURRENT
 *     binding) is what authorizes operating on an already-created session.
 *     This is the "set vs binding split" the design doc describes.
 *
 * Why the PTY-identity assertion does NOT read `pty.pid`'s own owner
 * directly: `MultiUserMode.spawnSudoPty` spawns `sudo -u <user> ... -i sh -c
 * '<sentinel>; exec $SHELL'` as the PTY process. Depending on the sudo
 * build, PTY/PAM-session handling commonly forks a "monitor" process that
 * stays at the ORIGINAL (invoking) identity while a child performs the
 * actual setuid+exec into the target user's shell -- so `pty.pid` itself is
 * not reliably the account-owned process. Two different, mode-appropriate
 * techniques are used instead:
 *
 *   - DEFAULT mode (known target accounts): scan every live `/proc/<pid>/environ`
 *     AS EACH TARGET ACCOUNT (via the real `runAsUser`) for the exact record
 *     `AGENT_CONSOLE_SESSION_ID=<sessionId>` that `buildAgentConsoleEnv`
 *     injects into every spawned agent process (`packages/server/src/
 *     services/agent-console-env.ts`) -- the same technique and match
 *     semantics `check-embedded-agent-elevation.ts`'s Issue #1694 positive
 *     identity assertion and `orphan-process-sweeper.ts`'s sweep use. A
 *     4-way cross-check matrix (does account A's tree carry session1's
 *     record? session2's? does account B's tree carry session2's? session1's?)
 *     is both the positive proof and its own negative control, scanned
 *     against real alternate sessions rather than merely a random string.
 *   - `--expect-global-account` polarity mode (account identity is NOT
 *     known in advance -- see below): descend each PTY's first-child
 *     process chain to its deepest live descendant (crossing whatever
 *     setuid boundary sudo introduced) and compare the two descendants'
 *     OS-level owning username via `stat -c %U /proc/<pid>` (no elevation
 *     needed: `/proc/<pid>`'s own directory metadata is world-stat-able on
 *     Linux -- only reading its CONTENTS, e.g. `environ`, is restricted).
 *     This needs no foreknowledge of which account is involved, which is
 *     exactly what the polarity run needs: on the Release 1 tree, a shared
 *     session's spawn identity came from a single globally-configured
 *     account (env-var based), not from either of this smoke's two target
 *     accounts, so a known-target scan cannot be used there.
 *
 * Polarity (`--expect-global-account`): skips the per-account environ-scan
 * matrix and instead asserts BOTH sessions' PTYs resolve to the SAME owning
 * username (whichever it is). Meant to be run against the Release 1 tree
 * (`git checkout` to the commit before this PR) to confirm the apparatus
 * would have shown the OLD single-global-account behavior there -- it MUST
 * FAIL on this (Release 2) tree, since R1 and R2 are bound to different
 * accounts. Per the delegation brief: no tree-switching mechanism is
 * implemented here; the orchestrating session runs this exact file against
 * both trees and records both exits.
 *
 * Authentication bypass: a thin outer middleware would be overridden by the
 * real `/api` router's own `.use('*', authMiddleware)` (mounted inside
 * `api` itself, before every route), so the bypass instead monkey-patches
 * `ctx.userMode.authenticate` to always return a fixed, synthetic "operator"
 * `AuthUser` -- the SAME seam `authMiddleware` already calls, and the same
 * technique this codebase's own route unit tests use via a fake `UserMode`
 * (`routes/__tests__/shared-accounts.test.ts`'s `mockUserMode`). Critically,
 * only `.authenticate` is replaced; `ctx.userMode.spawnPty` (the real
 * `MultiUserMode` instance's own method) is left untouched, since that is
 * the exact method `WorkerManager` calls to elevate-spawn the agent PTYs
 * this smoke is trying to verify -- replacing the whole `userMode` object
 * would silently break elevation instead of merely bypassing auth.
 *
 * Two real, separate scratch git repositories (`createScratchGitRepo`,
 * never a hand-rolled `git init`) stand in for R1/R2. Unlike the disposable
 * `AGENT_CONSOLE_HOME` (which gets the production `2775` setgid contract via
 * `createDisposableMultiUserHome`, so a target account sharing this
 * process's group can create the worktree's `wt-*` directory under the
 * server-owned, trusted `repositories/<org>/<repo>/worktrees/` chain), a
 * scratch repo created via `mkdtemp` is hardcoded to mode `0700` regardless
 * of umask (POSIX `mkdtemp(3)`) and lives OUTSIDE `AGENT_CONSOLE_HOME`
 * entirely. `git worktree add`, running ELEVATED as the bound account, needs
 * to both READ the source repo's objects/refs AND WRITE a new entry under
 * its `.git/worktrees/` registry -- so each scratch repo is `chmod -R
 * g+rwX`'d (group read/write/traverse) immediately after creation, on the
 * assumption that the target accounts share this process's primary group
 * (the same assumption `createDisposableMultiUserHome`'s gid check already
 * makes for every sibling elevation smoke in this file). This is NOT opened
 * to "other" (world-writable) -- see test-trigger.md's "a smoke's own
 * fixture directory must not be world-writable" expectation; it is this
 * smoke's own disposable fixture, never the operator's or another
 * application's files (`os-environment-coupling.md` Discipline 2).
 *
 * Usage:
 *   bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username>
 *   bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username> --expect-global-account
 *
 * Requirements:
 *   - Run as a user with elevation privilege for BOTH target usernames (the
 *     same precondition as `check-embedded-agent-elevation.ts`, doubled).
 *   - Both target usernames must be real OS users with a login shell, and
 *     should share a primary group with the invoking process (see the
 *     scratch-repo chmod rationale above).
 *   - No `claude` CLI login and no provider key are needed: this smoke
 *     checks PTY spawn IDENTITY only, immediately after spawn -- the agent
 *     CLI command is injected into the PTY only after the login-shell
 *     sentinel is observed, which this smoke never waits for. Free, no LLM
 *     turn, Tier 2.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing args, an OS user that doesn't
 *      resolve, a disposable-home setup failure, or a shared worktree
 *      session that never appeared within its deadline -- the latter most
 *      likely means elevation itself failed, e.g. missing sudoers
 *      configuration for one of the two target users)
 *
 * Sync contract: the real `/api` router (`routes/api.ts`), `SessionManager`,
 * `RepositoryManager`, and `createScratchGitRepo` are imported directly --
 * no replication of any production logic.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { createDisposableMultiUserHome } from './disposable-multi-user-home.js';
import { getConfigDir } from '../../packages/server/src/lib/config.js';
import type { AppContext } from '../../packages/server/src/app-context.js';

/**
 * Marks a setup/launch failure distinct from an unexpected exception during
 * the actual probe run -- same convention as `check-embedded-agent-
 * elevation.ts`'s identically-named class.
 */
class SmokeSetupError extends Error {}

function printUsageAndExit(reason: string): never {
  console.error(`error: ${reason}`);
  console.error(
    'usage: bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username> [--expect-global-account]',
  );
  process.exit(2);
}

/**
 * Exported for `__tests__/check-shared-account-binding.test.ts` (import-safe:
 * the only top-level invocation in this file is behind `import.meta.main`).
 */
export function parseArgs(argv: string[]): {
  accountAUsername: string;
  accountBUsername: string;
  expectGlobalAccount: boolean;
} {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const positionals: string[] = [];
  let expectGlobalAccount = false;
  for (const arg of args) {
    if (arg === '--expect-global-account') {
      expectGlobalAccount = true;
    } else if (arg.startsWith('--')) {
      printUsageAndExit(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  const [accountAUsername, accountBUsername, ...rest] = positionals;
  if (!accountAUsername || !accountBUsername) {
    printUsageAndExit('missing <account-A-username> and/or <account-B-username>');
  }
  if (rest.length > 0) {
    printUsageAndExit(`unexpected extra argument(s): ${rest.join(', ')}`);
  }
  return { accountAUsername, accountBUsername, expectGlobalAccount };
}

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string): void => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

/** `stat -c %U /proc/<pid>` -- no elevation needed, see header comment. */
function getProcOwnerUsername(pid: number): string | undefined {
  const result = Bun.spawnSync(['stat', '-c', '%U', `/proc/${pid}`]);
  if (result.exitCode !== 0) return undefined;
  const out = result.stdout.toString().trim();
  return out.length > 0 ? out : undefined;
}

/** `/proc/<pid>/task/<pid>/children` -- readable without elevation when the reader shares `pid`'s own uid (true here: `pid` is this process's own direct PTY child). */
function readChildPids(pid: number): number[] {
  try {
    const content = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8').trim();
    if (!content) return [];
    return content
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * Descends the first-child chain from `pid` to its deepest live descendant.
 * See header comment: this codebase's elevated PTY spawn is a linear chain
 * immediately after spawn (no branching until the agent CLI itself starts,
 * which this smoke never waits for), so "deepest descendant" finds the
 * process that actually crossed the setuid boundary, regardless of whether
 * a particular sudo build forks a monitor or execs in place.
 */
function resolveLeafPid(pid: number, maxDepth = 10): number {
  let current = pid;
  for (let i = 0; i < maxDepth; i++) {
    const children = readChildPids(current);
    if (children.length === 0) break;
    current = children[0];
  }
  return current;
}

/**
 * Polls the first-child chain + owner until two consecutive readings agree
 * (the fork/exec chain has settled) or `timeoutMs` elapses, returning the
 * last reading either way.
 */
async function waitForStableOwner(pid: number, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastOwner: string | undefined;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const owner = getProcOwnerUsername(resolveLeafPid(pid));
    if (owner !== undefined && owner === lastOwner) {
      stableCount++;
      if (stableCount >= 2) return owner;
    } else {
      stableCount = 0;
    }
    lastOwner = owner;
    await new Promise((r) => setTimeout(r, 300));
  }
  return lastOwner;
}

async function main(): Promise<void> {
  // Ad-hoc invocation inherits cwd from the caller; neutralize before any
  // elevated spawn (same rationale as every sibling elevation smoke).
  process.chdir('/');

  const { accountAUsername, accountBUsername, expectGlobalAccount } = parseArgs(process.argv.slice(2));

  // CRITICAL ordering: must be set before any module that transitively
  // reads `serverConfig.AUTH_MODE` at module-load time is evaluated -- see
  // `check-embedded-agent-elevation.ts`'s identical comment for the full
  // rationale. Everything below that needs it is dynamically imported only
  // after this assignment.
  process.env.AUTH_MODE = 'multi-user';

  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.js');
  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { onApiError } = await import('../../packages/server/src/lib/error-handler.js');
  const { runAsUser, shellEscape } = await import('../../packages/server/src/services/privilege-elevation.js');
  const { createScratchGitRepo } = await import('../../packages/server/src/__tests__/utils/scratch-git.js');

  // `hono` is only hoisted under packages/server/node_modules (and
  // packages/client, packages/shared) -- same resolution trick as
  // `check-embedded-agent-elevation.ts`.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  console.log('==> resolving real target OS users');
  const osUserA = await lookupOsUser(accountAUsername);
  if (!osUserA) {
    console.error(`PROBE FAILED: could not resolve OS user '${accountAUsername}' via lookupOsUser`);
    process.exit(2);
  }
  const osUserB = await lookupOsUser(accountBUsername);
  if (!osUserB) {
    console.error(`PROBE FAILED: could not resolve OS user '${accountBUsername}' via lookupOsUser`);
    process.exit(2);
  }
  console.log(`  account A: ${accountAUsername} (uid=${osUserA.uid})`);
  console.log(`  account B: ${accountBUsername} (uid=${osUserB.uid})`);
  const serverUsername = os.userInfo().username;
  for (const [label, username] of [
    ['account A', accountAUsername],
    ['account B', accountBUsername],
  ] as const) {
    if (username === serverUsername) {
      console.warn(
        `  WARN  ${label} '${username}' equals the server-process user; its elevation will bypass sudo` +
          ' (degenerate same-user mode). This still exercises the full binding/spawn-identity pipeline' +
          ' except the actual cross-user sudo boundary.',
      );
    }
  }

  let ctx: AppContext | undefined;
  let realConfigDir: string | undefined;
  let prevUmask: number | undefined;
  let repo1: Awaited<ReturnType<typeof createScratchGitRepo>> | undefined;
  let repo2: Awaited<ReturnType<typeof createScratchGitRepo>> | undefined;
  let sessionId1: string | undefined;
  let sessionId2: string | undefined;

  try {
    // --- Disposable AGENT_CONSOLE_HOME, assigned BEFORE createTestContext,
    // satisfying the production data-root's 2775 setgid contract. ---
    const homeResult = await createDisposableMultiUserHome('ac-shared-binding-smoke-cfg-');
    if (!homeResult.ok) {
      throw new SmokeSetupError(
        `cannot build a disposable AGENT_CONSOLE_HOME satisfying the multi-user data-root 2775 contract: ${homeResult.reason}`,
      );
    }
    realConfigDir = homeResult.path;
    prevUmask = homeResult.prevUmask;
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    const configDirBeforeContext = getConfigDir();
    if (configDirBeforeContext !== realConfigDir) {
      throw new SmokeSetupError(
        `context data root is not the disposable home before createTestContext: ` +
          `getConfigDir()=${configDirBeforeContext} realConfigDir=${realConfigDir}`,
      );
    }

    ctx = await createTestContext();
    const contextConfigDir = getConfigDir();
    if (contextConfigDir !== realConfigDir) {
      throw new SmokeSetupError(
        `context data root is not the disposable home after createTestContext: ` +
          `getConfigDir()=${contextConfigDir} realConfigDir=${realConfigDir}`,
      );
    }

    // --- Authentication bypass: fixed synthetic "operator" caller, neither
    // account A nor account B, so step (f)'s re-check below cannot pass by
    // coincidentally matching `isOwner`. Only `.authenticate` is patched on
    // the REAL `MultiUserMode` instance -- see header comment. ---
    console.log('==> installing fixed-operator auth bypass (userMode.authenticate only)');
    const operatorAuthUser = await ctx.userRepository.upsertByOsUid(
      -1,
      'smoke-operator',
      '/nonexistent/smoke-operator',
    );
    ctx.userMode.authenticate = () => operatorAuthUser;

    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);

    // --- Two real, separate scratch git repositories. ---
    console.log('==> creating two scratch git repositories (R1, R2)');
    const scratchParent = path.join(os.tmpdir(), `ac-shared-binding-smoke-${crypto.randomUUID()}`);
    repo1 = await createScratchGitRepo({ parentDir: scratchParent, name: 'r1-' });
    repo2 = await createScratchGitRepo({ parentDir: scratchParent, name: 'r2-' });
    await repo1.git(['branch', 'feature-a']);
    await repo2.git(['branch', 'feature-b']);
    // Group read/write/traverse so `git worktree add`, elevated as the
    // bound account, can read R1/R2's objects and write a new
    // `.git/worktrees/` entry. See header comment -- never world-writable.
    Bun.spawnSync(['chmod', '-R', 'g+rwX', repo1.dir]);
    Bun.spawnSync(['chmod', '-R', 'g+rwX', repo2.dir]);

    // --- Register both repositories. ---
    console.log('==> registering R1, R2');
    const registerRepo = async (repoPath: string): Promise<string> => {
      const res = await app.request('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      const body = (await res.json()) as { repository?: { id: string } };
      expect(res.status === 201, `POST /api/repositories (${repoPath}) returns 201`, `got ${res.status}: ${JSON.stringify(body)}`);
      if (!body.repository) {
        throw new SmokeSetupError(`repository registration did not return a repository id: ${JSON.stringify(body)}`);
      }
      return body.repository.id;
    };
    const repoId1 = await registerRepo(repo1.dir);
    const repoId2 = await registerRepo(repo2.dir);

    // --- Register both shared accounts. ---
    console.log('==> registering shared accounts A, B');
    const registerSharedAccount = async (username: string): Promise<void> => {
      const res = await app.request('/api/shared-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      expect(res.status === 201, `POST /api/shared-accounts (${username}) returns 201`, `got ${res.status}: ${await res.text()}`);
    };
    await registerSharedAccount(accountAUsername);
    await registerSharedAccount(accountBUsername);

    // --- Bind R1 -> A, R2 -> B. ---
    console.log('==> binding R1 -> account A, R2 -> account B');
    const bindRepo = async (repoId: string, sharedAccountUsername: string): Promise<void> => {
      const res = await app.request(`/api/repositories/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedAccountUsername }),
      });
      expect(
        res.status === 200,
        `PATCH /api/repositories/${repoId} { sharedAccountUsername: '${sharedAccountUsername}' } returns 200`,
        `got ${res.status}: ${await res.text()}`,
      );
    };
    await bindRepo(repoId1, accountAUsername);
    await bindRepo(repoId2, accountBUsername);

    // --- Create a shared worktree session on each repository through the
    // REAL (fire-and-forget) HTTP route. ---
    console.log('==> creating shared worktree sessions on R1 and R2');
    const createSharedWorktree = async (repoId: string, branch: string): Promise<void> => {
      const res = await app.request(`/api/repositories/${repoId}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: crypto.randomUUID(),
          mode: 'existing',
          branch,
          shared: true,
          autoStartSession: true,
        }),
      });
      expect(res.status === 202, `POST /api/repositories/${repoId}/worktrees (shared) returns 202`, `got ${res.status}: ${await res.text()}`);
    };
    await createSharedWorktree(repoId1, 'feature-a');
    await createSharedWorktree(repoId2, 'feature-b');

    // --- Poll (in-process, no WS needed) for each session to appear with
    // its initial agent worker activated. ---
    const waitForActivatedWorktreeSession = async (
      repoId: string,
      timeoutMs: number,
    ): Promise<{ sessionId: string; workerId: string } | undefined> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sessions = ctx!.sessionManager.getAllSessions();
        const match = sessions.find((s) => s.type === 'worktree' && s.repositoryId === repoId);
        if (match) {
          const agentWorker = match.workers.find((w) => w.type === 'agent');
          if (agentWorker && agentWorker.activated) {
            return { sessionId: match.id, workerId: agentWorker.id };
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return undefined;
    };
    const WORKTREE_SESSION_DEADLINE_MS = 60_000;
    const found1 = await waitForActivatedWorktreeSession(repoId1, WORKTREE_SESSION_DEADLINE_MS);
    const found2 = await waitForActivatedWorktreeSession(repoId2, WORKTREE_SESSION_DEADLINE_MS);
    if (!found1) {
      throw new SmokeSetupError(
        `shared worktree session on R1 (repoId=${repoId1}) never appeared with an activated agent worker within ${WORKTREE_SESSION_DEADLINE_MS}ms -- elevation as '${accountAUsername}' most likely failed (check sudoers configuration for that user)`,
      );
    }
    if (!found2) {
      throw new SmokeSetupError(
        `shared worktree session on R2 (repoId=${repoId2}) never appeared with an activated agent worker within ${WORKTREE_SESSION_DEADLINE_MS}ms -- elevation as '${accountBUsername}' most likely failed (check sudoers configuration for that user)`,
      );
    }
    sessionId1 = found1.sessionId;
    sessionId2 = found2.sessionId;
    const workerId1 = found1.workerId;
    const workerId2 = found2.workerId;
    console.log(`  R1 session: ${sessionId1} (worker ${workerId1})`);
    console.log(`  R2 session: ${sessionId2} (worker ${workerId2})`);

    const internalWorker1 = ctx.sessionManager.getWorker(sessionId1, workerId1);
    const internalWorker2 = ctx.sessionManager.getWorker(sessionId2, workerId2);
    const pid1 = internalWorker1 && internalWorker1.type === 'agent' ? internalWorker1.pty?.pid : undefined;
    const pid2 = internalWorker2 && internalWorker2.type === 'agent' ? internalWorker2.pty?.pid : undefined;
    expect(pid1 !== undefined, 'R1 agent worker has a live PTY pid');
    expect(pid2 !== undefined, 'R2 agent worker has a live PTY pid');

    // --- Assertion (d): PTY spawn identity. ---
    if (expectGlobalAccount) {
      console.log('==> --expect-global-account: asserting BOTH sessions run as the SAME account');
      if (pid1 === undefined || pid2 === undefined) {
        expect(false, 'both sessions run as the same account', 'no pid to compare (see earlier failure)');
      } else {
        const owner1 = await waitForStableOwner(pid1, 10_000);
        const owner2 = await waitForStableOwner(pid2, 10_000);
        console.log(`  R1 leaf-process owner: ${owner1 ?? '(unresolved)'}`);
        console.log(`  R2 leaf-process owner: ${owner2 ?? '(unresolved)'}`);
        expect(
          owner1 !== undefined && owner1 === owner2,
          'both sessions\' PTYs resolve to the same owning OS account (Release-1-style global shared account)',
          `owner1=${owner1} owner2=${owner2}`,
        );
      }
    } else {
      console.log('==> per-account PTY identity: environ-scan cross-check matrix');
      const countEnvironMatches = async (username: string, marker: string): Promise<number | undefined> => {
        const script = [
          'set -u',
          `marker=${shellEscape(marker)}`,
          'matches=0',
          'for envfile in /proc/[0-9]*/environ; do',
          '  [ -e "$envfile" ] || continue',
          '  if grep -Fxzq -- "$marker" "$envfile" 2>/dev/null; then',
          '    matches=$((matches + 1))',
          '  fi',
          'done',
          'echo "MATCHES=$matches"',
          '',
        ].join('\n');
        const result = await runAsUser({ username, command: 'sh -s', stdin: script, cwd: '/', timeoutMs: 30_000 });
        const m = /^MATCHES=(\d+)\s*$/m.exec(result.stdout);
        if (result.exitCode !== 0 || result.timedOut || m === null) {
          console.error(
            `  scan as ${username} for marker did not produce a MATCHES line: exit=${result.exitCode} timedOut=${result.timedOut} stderr=${result.stderr.slice(0, 500)}`,
          );
          return undefined;
        }
        return Number(m[1]);
      };

      const markerFor = (sessionId: string): string => `AGENT_CONSOLE_SESSION_ID=${sessionId}`;
      const matchesA_session1 = await countEnvironMatches(accountAUsername, markerFor(sessionId1));
      const matchesA_session2 = await countEnvironMatches(accountAUsername, markerFor(sessionId2));
      const matchesB_session2 = await countEnvironMatches(accountBUsername, markerFor(sessionId2));
      const matchesB_session1 = await countEnvironMatches(accountBUsername, markerFor(sessionId1));

      expect(matchesA_session1 !== undefined, `environ scan as ${accountAUsername} for session1's marker actually ran`);
      expect(matchesA_session2 !== undefined, `environ scan as ${accountAUsername} for session2's marker actually ran`);
      expect(matchesB_session2 !== undefined, `environ scan as ${accountBUsername} for session2's marker actually ran`);
      expect(matchesB_session1 !== undefined, `environ scan as ${accountBUsername} for session1's marker actually ran`);

      expect(
        (matchesA_session1 ?? 0) >= 1,
        `R1's session runs as account A: a live process in ${accountAUsername}'s own tree carries R1's session-id record`,
        `matches=${matchesA_session1}`,
      );
      expect(
        (matchesA_session2 ?? -1) === 0,
        `negative control: account A's tree does NOT carry R2's session-id record`,
        `matches=${matchesA_session2}`,
      );
      expect(
        (matchesB_session2 ?? 0) >= 1,
        `R2's session runs as account B: a live process in ${accountBUsername}'s own tree carries R2's session-id record`,
        `matches=${matchesB_session2}`,
      );
      expect(
        (matchesB_session1 ?? -1) === 0,
        `negative control: account B's tree does NOT carry R1's session-id record`,
        `matches=${matchesB_session1}`,
      );
    }

    // --- Assertion (e): quick sessions can never be shared (unconditional 400). ---
    console.log('==> quick session with shared:true is unconditionally rejected');
    const quickSharedRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'quick', locationPath: os.tmpdir(), shared: true }),
    });
    expect(quickSharedRes.status === 400, 'POST /api/sessions { type: quick, shared: true } returns 400', `got ${quickSharedRes.status}: ${await quickSharedRes.text()}`);

    // --- Rebind R1 -> account B. ---
    console.log('==> rebinding R1 -> account B');
    await bindRepo(repoId1, accountBUsername);

    // --- Assertion (f): the EXISTING R1 session (created against the OLD
    // binding to account A, before the rebind) is still operable by the
    // fixed operator caller -- neither its owner (account A) nor the
    // repository's NEW binding (account B). Only membership of the shared-
    // account SET (account A is still registered) authorizes this. ---
    console.log('==> existing R1 session is still operable after rebinding R1 -> B (set vs binding split)');
    const memoRes = await app.request(`/api/sessions/${sessionId1}/memo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'shared-account-binding smoke memo check' }),
    });
    expect(
      memoRes.status === 200,
      `PUT /api/sessions/${sessionId1}/memo (as operator, neither owner nor current binding) returns 200, not 403`,
      `got ${memoRes.status}: ${await memoRes.text()}`,
    );
  } catch (err) {
    if (err instanceof SmokeSetupError) {
      console.error('PROBE FAILED: smoke could not run to completion (setup/launch failure)');
      console.error(err.stack ?? err.message);
      process.exitCode = 2;
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup');
    if (prevUmask !== undefined) {
      process.umask(prevUmask);
    }
    if (ctx) {
      for (const sid of [sessionId1, sessionId2]) {
        if (!sid) continue;
        try {
          await ctx.sessionManager.deleteSession(sid);
        } catch (err) {
          console.warn(`  cleanup: deleteSession(${sid}) failed (best-effort):`, err);
        }
      }
      try {
        await shutdownAppContext(ctx);
      } catch (err) {
        console.warn('  cleanup: shutdownAppContext failed (best-effort):', err);
      }
    }
    for (const repo of [repo1, repo2]) {
      if (!repo) continue;
      try {
        await repo.cleanup();
      } catch (err) {
        console.warn('  cleanup: scratch repo cleanup failed (best-effort):', err);
      }
    }
    if (realConfigDir) {
      Bun.spawnSync(['rm', '-rf', realConfigDir]);
    }
  }

  console.log();
  if (process.exitCode === 2) {
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

// Guarded (Issue #1479): importing this module must not fire a run as a
// side effect. `import.meta.main` is false for an importer, true only when
// this file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
}
