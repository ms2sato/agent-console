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
 *   - asserts each session's PTY actually runs as its OWN bound account
 *     (real OS-level process ownership, not merely a `createdBy` DB column)
 *   - asserts a quick session can never be `shared: true` (400,
 *     unconditional)
 *   - rebinds R1 -> B, then asserts the EXISTING R1 session (created
 *     against the OLD binding, before the rebind) is STILL operable by a
 *     caller who is neither its owner nor the account it is now bound to --
 *     proving membership of the shared-account SET (not the CURRENT
 *     binding) is what authorizes operating on an already-created session.
 *     This is the "set vs binding split" the design doc describes.
 *
 * Q13 recorded proxy (pre-pr-completeness.md): the PTY-identity assertion
 * reads a TERMINAL-type worker added to the shared session, not the
 * session's own initial AGENT-type worker. Production-real: the route, the
 * binding resolution (`repository.sharedAccountUserId` -> the registry),
 * `session.created_by` = the bound account, and the elevation itself --
 * `activateAgentWorkerPty` and `activateTerminalWorkerPty` both resolve
 * identity via the IDENTICAL `session.createdBy -> resolveSpawnUsername ->
 * spawnPty` chain (verified directly in `worker-manager.ts` /
 * `worker-lifecycle-manager.ts`: the two activation functions differ only
 * in the downstream command string `spawnPty` builds -- an agent CLI
 * invocation vs a plain login shell -- never in how the target user is
 * resolved). Substituted: WHICH worker type's PTY this smoke reads identity
 * through. The reason is upstream of and outside the binding/elevation
 * chain under test: this Docker verification container has no `claude` CLI
 * login (by design -- see test-trigger.md's Tier-2 scope), so the session's
 * own agent-type worker predictably exits 127 ("command not found") moments
 * after its PTY activates, and `WorkerManager.detachPty` (the ordinary,
 * correct exit-handler path -- see Issue #1294's exit-127 diagnostic) resets
 * its `pty` back to `null` well within this smoke's polling granularity.
 * Reading identity through an added terminal-type worker (a plain login
 * shell, no agent CLI ever invoked) sidesteps that exit entirely without
 * touching the binding/elevation logic this smoke exists to verify. This
 * substitution was confirmed by direct object-identity-tagged instrumentation
 * (the exact same worker object showed `pty !== null` at the write site and
 * `pty === null` moments later purely due to the exit-127 teardown) before
 * landing -- it is not a hypothesis.
 *
 * Second Q13 recorded proxy: `createTestContext()` defaults to
 * `SingleUserMode` (every PTY spawns unelevated, as the server process's own
 * OS user) UNLESS a `MultiUserMode` instance is explicitly supplied via
 * `overrides.userMode` -- `process.env.AUTH_MODE = 'multi-user'` is read by
 * OTHER code this smoke depends on (`createDisposableMultiUserHome`'s `2775`
 * contract) but NOT by this specific decision in `app-context.ts`. This
 * smoke therefore constructs a real `MultiUserMode.create(bunPtyProvider,
 * <userRepository>)` itself and injects it. The `userRepository` passed to
 * that factory is a proxy: a throwaway, unshared, in-memory database,
 * substituted because `MultiUserMode.create` only reads it later, inside
 * `.login()` -- which authenticates OS credentials against it -- and this
 * smoke never calls `.login()` (auth is bypassed via the monkey-patched
 * `.authenticate` described below). Everything `MultiUserMode` actually
 * exercises for this smoke's purposes -- `spawnSudoPty`'s argv construction
 * and the real elevated `sudo` invocation -- uses the real, shared
 * `bunPtyProvider`, never the proxy. Omitting this override was a real,
 * previously-undetected defect in this smoke (and, before this PR, in its
 * precursor): every PTY it drove was silently unelevated, so the identity
 * assertions below were passing (or, after the terminal-worker change,
 * failing with a hard timeout) for the wrong reason. Confirmed by removing
 * the override and re-running: every PTY-identity assertion failed (the
 * terminal worker's PTY never activated within its 30s deadline -- see the
 * PR body for the recorded exit).
 *
 * Reach record for the "PTY owner is not the server process's own user"
 * assertions (Issue #1848; measured 2026-10-08 in the tier-2 verification
 * container, nothing from the measurement is committed). The mutation, as
 * text: after the auth bypass, replace the `MultiUserMode` instance's
 * `spawnPty` with one that delegates to a `SingleUserMode` built on the same
 * `bunPtyProvider`, so that everything upstream (routes, binding resolution,
 * `created_by`, `resolveSpawnUsername`, the terminal-worker add) runs
 * unchanged and the ONLY thing that moves is who the PTY runs as. Two
 * recorded proxies, both upstream of and outside the identity chain (the
 * leaf owner is the PTY process's uid, which neither can change): (1) the
 * mutated `spawnPty` substitutes `cwd` with `os.tmpdir()`, because the
 * worktree cwd is unenterable for the server user (the reason the earlier
 * `SingleUserMode` removal died with an activation timeout instead of
 * reaching the owner check); (2) the mutated run's `docker compose exec`
 * passes `--env SHELL=/bin/sh`, because the unelevated terminal spawn is
 * `sh -c 'exec $SHELL -l'` (user-mode.ts) and the container's server
 * account has an empty `SHELL` and a nologin passwd shell, so the PTY
 * exits 1 within ~30ms. Two independent environment facts (cwd, shell), not
 * one, stood between the old mutation and the owner check. `SHELL` cannot
 * reach the elevated arm: elevation-args.ts lists it in the PROTECTED set
 * stripped from the exports crossing the privilege boundary, and the
 * elevated shell's own login init sets it from the target's passwd entry;
 * env-filter.ts carries it into the direct spawn, which is why the proxy
 * works. The unmodified control was re-run under the same `--env` so the two
 * runs differ in the `spawnPty` patch only. Result: the PTY activated (the
 * "activated a PTY" assertions stayed OK), both leaf owners resolved to
 * the server user, and the "PTY owner is not the server process's own user"
 * assertions FAILED with `got <server user>` for R1 and R2 (exit 1; the
 * account-equality and DIFFERENT-accounts assertions also failed, expected
 * and uninformative). So the smoke catches a shared session that quietly ran
 * as the server account instead of the bound one, not just one that failed
 * to start. A run where the PTY does not activate or an owner is unresolved
 * is INCONCLUSIVE for this question, never a measurement of those assertions.
 *
 * Why the PTY-identity assertion does NOT read `pty.pid`'s own owner
 * directly: `MultiUserMode.spawnPty` spawns `sudo -u <user> ... -i sh -c
 * '<sentinel>; exec $SHELL'` as the PTY process. Depending on the sudo
 * build, PTY/PAM-session handling commonly forks a "monitor" process that
 * stays at the ORIGINAL (invoking) identity while a child performs the
 * actual setuid+exec into the target user's shell -- so `pty.pid` itself is
 * not reliably the account-owned process. Instead: descend each PTY's
 * first-child process chain to its deepest live descendant (crossing
 * whatever setuid boundary sudo introduced) and compare that descendant's
 * OS-level owning username via `stat -c %U /proc/<pid>` (no elevation
 * needed: `/proc/<pid>`'s own directory metadata is world-stat-able on
 * Linux). This technique needs no foreknowledge of environment variables the
 * spawned process carries -- unlike an `/proc/<pid>/environ` scan for
 * `AGENT_CONSOLE_SESSION_ID` (which only terminal-type workers would lack
 * anyway, since `buildAgentConsoleEnv` is only called on the `'agent'`
 * branch of `spawnDirectPty`/the elevated equivalent -- confirmed in
 * `user-mode.ts`), it reads real OS process ownership directly.
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
 * the exact method `WorkerManager` calls to elevate-spawn PTYs -- replacing
 * the whole `userMode` object would silently break elevation instead of
 * merely bypassing auth.
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
 *
 * Requirements:
 *   - Run as a user with elevation privilege for BOTH target usernames (the
 *     same precondition as `check-embedded-agent-elevation.ts`, doubled).
 *   - Both target usernames must be real OS users with a login shell, and
 *     should share a primary group with the invoking process (see the
 *     scratch-repo chmod rationale above).
 *   - No `claude` CLI login and no provider key are needed: the PTY-identity
 *     check runs through a terminal-type worker (a login shell only),
 *     deliberately never through the session's own agent-type worker. Free,
 *     no LLM turn, Tier 2.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing args, an OS user that doesn't
 *      resolve, a disposable-home setup failure, a shared worktree session
 *      that never appeared within its deadline, or its added terminal
 *      worker never activating within its own deadline -- either most
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
    'usage: bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username>',
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
} {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
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
  return { accountAUsername, accountBUsername };
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
 * immediately after spawn (no branching for a terminal-type worker -- it
 * execs straight into the target user's login shell, never a second
 * command), so "deepest descendant" finds the process that actually crossed
 * the setuid boundary, regardless of whether a particular sudo build forks
 * a monitor or execs in place.
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

  const { accountAUsername, accountBUsername } = parseArgs(process.argv.slice(2));

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
  const { createScratchGitRepo } = await import('../../packages/server/src/__tests__/utils/scratch-git.js');
  const { MultiUserMode } = await import('../../packages/server/src/services/user-mode.js');
  const { bunPtyProvider } = await import('../../packages/server/src/lib/pty-provider.js');
  const { createDatabaseForTest } = await import('../../packages/server/src/database/connection.js');
  const { SqliteUserRepository } = await import('../../packages/server/src/repositories/sqlite-user-repository.js');

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
  // `os.userInfo().username` resolves to the literal string `'unknown'` in
  // this container (Bun's NSS lookup does not resolve the invoking uid under
  // `docker compose exec --user <name>`, confirmed independently via `id -un`
  // succeeding while `os.userInfo()` does not) -- `id -un` is the reliable
  // source here.
  const idResult = Bun.spawnSync(['id', '-un']);
  const serverUsername = idResult.exitCode === 0 ? idResult.stdout.toString().trim() : os.userInfo().username;
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

    // `createTestContext()` defaults to `SingleUserMode` (no elevation --
    // every PTY spawns as the server process's own OS user) UNLESS a
    // `MultiUserMode` instance is explicitly passed via `overrides.userMode`
    // -- `process.env.AUTH_MODE = 'multi-user'` above is read by OTHER code
    // (e.g. `createDisposableMultiUserHome`'s 2775 contract) but NOT by this
    // decision (`app-context.ts`'s `createTestContext`: `userMode =
    // overrides?.userMode ?? await SingleUserMode.create(...)`). Without
    // this override, every PTY in this smoke -- including the terminal
    // worker this smoke exists to probe -- would spawn unelevated as the
    // invoking OS user, never as the bound account. `MultiUserMode.create`
    // only loads/generates a JWT secret at construction time and never reads
    // the `UserRepository` it's given until `.login()` is called (never
    // called here -- auth is bypassed below), so a throwaway in-memory
    // repository is sufficient; it never needs to share state with the
    // context's own database.
    const multiUserModeUserRepoDb = await createDatabaseForTest();
    const multiUserMode = await MultiUserMode.create(bunPtyProvider, new SqliteUserRepository(multiUserModeUserRepoDb));

    ctx = await createTestContext({ userMode: multiUserMode });
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
    // REAL (fire-and-forget) HTTP route. `autoStartSession:true` so the
    // session row carries a real `created_by`/`initiated_by` pair (kept per
    // the Orchestrator's instruction -- this is the DB-side evidence that
    // complements the terminal-worker PTY probe below). The session's own
    // initial AGENT-type worker is expected to activate its PTY and then
    // exit 127 moments later (no `claude` CLI in this container) -- this
    // smoke never waits on that worker at all, only on the session's
    // existence. ---
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

    // --- Poll (in-process, no WS needed) for each session to appear. Not
    // waiting on any worker's activation here -- see header comment. ---
    const waitForWorktreeSession = async (
      repoId: string,
      timeoutMs: number,
    ): Promise<string | undefined> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sessions = ctx!.sessionManager.getAllSessions();
        const match = sessions.find((s) => s.type === 'worktree' && s.repositoryId === repoId);
        if (match) return match.id;
        await new Promise((r) => setTimeout(r, 300));
      }
      return undefined;
    };
    const WORKTREE_SESSION_DEADLINE_MS = 30_000;
    const foundSessionId1 = await waitForWorktreeSession(repoId1, WORKTREE_SESSION_DEADLINE_MS);
    const foundSessionId2 = await waitForWorktreeSession(repoId2, WORKTREE_SESSION_DEADLINE_MS);
    if (!foundSessionId1) {
      throw new SmokeSetupError(
        `shared worktree session on R1 (repoId=${repoId1}) never appeared within ${WORKTREE_SESSION_DEADLINE_MS}ms -- elevation as '${accountAUsername}' most likely failed (check sudoers configuration for that user)`,
      );
    }
    if (!foundSessionId2) {
      throw new SmokeSetupError(
        `shared worktree session on R2 (repoId=${repoId2}) never appeared within ${WORKTREE_SESSION_DEADLINE_MS}ms -- elevation as '${accountBUsername}' most likely failed (check sudoers configuration for that user)`,
      );
    }
    sessionId1 = foundSessionId1;
    sessionId2 = foundSessionId2;
    console.log(`  R1 session: ${sessionId1}`);
    console.log(`  R2 session: ${sessionId2}`);

    // --- Assertion: the session row's created_by/initiated_by (agent-side
    // DB evidence, complementing the terminal-worker PTY probe below). ---
    const session1 = ctx.sessionManager.getSession(sessionId1);
    const session2 = ctx.sessionManager.getSession(sessionId2);
    const userA = await ctx.userRepository.upsertByOsUid(osUserA.uid, accountAUsername, osUserA.homeDir);
    const userB = await ctx.userRepository.upsertByOsUid(osUserB.uid, accountBUsername, osUserB.homeDir);
    expect(session1?.createdBy === userA.id, `R1 session row: created_by is account A's users.id`, `got ${session1?.createdBy}`);
    expect(session2?.createdBy === userB.id, `R2 session row: created_by is account B's users.id`, `got ${session2?.createdBy}`);
    expect(session1?.initiatedBy === operatorAuthUser.id, `R1 session row: initiated_by is the calling operator's users.id`, `got ${session1?.initiatedBy}`);
    expect(session2?.initiatedBy === operatorAuthUser.id, `R2 session row: initiated_by is the calling operator's users.id`, `got ${session2?.initiatedBy}`);

    // --- Add a terminal-type worker to each shared session and wait for
    // ITS PTY to activate (a plain login shell -- no agent CLI, so no
    // exit-127 teardown race). ---
    console.log('==> adding a terminal worker to each shared session, waiting for PTY activation');
    const addTerminalWorkerAndWaitForPty = async (
      sessionId: string,
      timeoutMs: number,
    ): Promise<number | undefined> => {
      const res = await app.request(`/api/sessions/${sessionId}/workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'terminal' }),
      });
      // Read the body exactly once -- a `Response`'s body stream throws
      // "Body already used" on a second `.text()`/`.json()` call.
      const resText = await res.text();
      expect(res.status === 201, `POST /api/sessions/${sessionId}/workers (terminal) returns 201`, `got ${res.status}: ${resText}`);
      if (res.status !== 201) return undefined;
      const body = JSON.parse(resText) as { worker?: { id: string } };
      const workerId = body.worker?.id;
      if (!workerId) return undefined;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const worker = ctx!.sessionManager.getWorker(sessionId, workerId);
        if (worker && worker.type === 'terminal' && worker.pty) {
          return worker.pty.pid;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return undefined;
    };
    const TERMINAL_WORKER_DEADLINE_MS = 30_000;
    const pid1 = await addTerminalWorkerAndWaitForPty(sessionId1, TERMINAL_WORKER_DEADLINE_MS);
    const pid2 = await addTerminalWorkerAndWaitForPty(sessionId2, TERMINAL_WORKER_DEADLINE_MS);
    expect(pid1 !== undefined, `R1's added terminal worker activated a PTY within ${TERMINAL_WORKER_DEADLINE_MS}ms`);
    expect(pid2 !== undefined, `R2's added terminal worker activated a PTY within ${TERMINAL_WORKER_DEADLINE_MS}ms`);

    // --- Assertion: PTY spawn identity, via OS-level process ownership of
    // each terminal worker's leaf (post-setuid) process. ---
    console.log('==> PTY identity: terminal-worker leaf process ownership');
    let owner1: string | undefined;
    let owner2: string | undefined;
    if (pid1 !== undefined) {
      owner1 = await waitForStableOwner(pid1, 10_000);
    }
    if (pid2 !== undefined) {
      owner2 = await waitForStableOwner(pid2, 10_000);
    }
    console.log(`  R1 leaf-process owner: ${owner1 ?? '(unresolved)'}`);
    console.log(`  R2 leaf-process owner: ${owner2 ?? '(unresolved)'}`);
    expect(owner1 === accountAUsername, `R1's terminal-worker PTY leaf process is owned by account A ('${accountAUsername}')`, `got ${owner1}`);
    expect(owner2 === accountBUsername, `R2's terminal-worker PTY leaf process is owned by account B ('${accountBUsername}')`, `got ${owner2}`);
    expect(
      owner1 !== undefined && owner1 !== owner2,
      `R1 and R2 run as DIFFERENT accounts (selectivity: per-repository binding, not a single global account)`,
      `owner1=${owner1} owner2=${owner2}`,
    );
    // Defense in depth against a `SingleUserMode` regression that somehow
    // leaves the PTY alive (this bug's actual manifestation was a hard
    // failure -- the PTY never activated at all, since `SingleUserMode`'s
    // unelevated `spawnDirectPty` hit a path this repository-bound worktree
    // cwd cannot satisfy -- but a future change could make an unelevated
    // spawn survive). Neither account should ever be the server process's
    // own OS user when elevation is genuinely happening.
    if (owner1 !== undefined) {
      expect(owner1 !== serverUsername, `R1's PTY owner is not the server process's own user ('${serverUsername}') -- elevation actually happened`, `got ${owner1}`);
    }
    if (owner2 !== undefined) {
      expect(owner2 !== serverUsername, `R2's PTY owner is not the server process's own user ('${serverUsername}') -- elevation actually happened`, `got ${owner2}`);
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
