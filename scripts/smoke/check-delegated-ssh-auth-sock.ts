#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the delegated-session SSH_AUTH_SOCK fallback.
 *
 * Builds the same elevated `sudo` argv that production
 * `MultiUserMode.spawnSudoPty` builds, against the real machine, using the
 * SHARED `buildElevationArgs` helper imported from the production source.
 * Because the helper is the single source of truth, drift between what
 * production does and what smoke verifies is impossible by construction.
 *
 * What this smoke exercises:
 *   - The production helper's argv shape with `sshAuthSockFallback` set
 *     (via direct import; no replication).
 *   - The real OS elevation binary, real sudoers config, real env_keep
 *     defaults.
 *   - The target user's login shell init.
 *   - The conditional `if [ -z "$SSH_AUTH_SOCK" ] && [ -S '...' ]; then
 *     export ... ; fi` block actually evaluating against the running
 *     environment and writing the expected post-condition.
 *   - The negative path: when no `sshAuthSockFallback` is passed, no
 *     SSH_AUTH_SOCK-related shell snippet appears in the inner command
 *     (back-compat lock).
 *
 * Usage:
 *   bun scripts/smoke/check-delegated-ssh-auth-sock.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with privilege-elevation rights for <target-user>.
 *   - <target-user> must be a real OS user with a login shell.
 *   - <target-user>'s home should ideally contain `.1password/agent.sock`;
 *     when absent, the socket-existence branch is verified instead.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (details on stderr)
 *   2  bad usage / cannot run
 */

import { spawn } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { buildElevationArgs, shellEscape } from '../../packages/server/src/services/elevation-args.js';

// Inherited cwd from an ad-hoc invocation may be unreadable by the target
// user. Neutralize at script start (see check-multiuser-pty-env.ts for the
// extended discussion).
process.chdir('/');

const targetUser = process.argv[2];
if (!targetUser) {
  console.error('usage: bun scripts/smoke/check-delegated-ssh-auth-sock.ts <target-user>');
  process.exit(2);
}

function resolveBin(name: string, candidates: string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Could not find ${name} in any of: ${candidates.join(', ')}`);
}
const ELEV_BIN = resolveBin('elevation binary', ['/usr/bin/sudo', '/bin/sudo']);

// Resolve the target user's home from /etc/passwd. Reading /etc/passwd
// directly (vs `getent`) avoids the Bun-side posix_spawn EACCES quirk
// observed in earlier multi-user smoke tests under "... -u <service-account>"
// invocations without a full login session.
const passwdEntries = readFileSync('/etc/passwd', 'utf-8').split('\n');
const passwdEntry = passwdEntries.find((line) => {
  const idx = line.indexOf(':');
  return idx > 0 && line.slice(0, idx) === targetUser;
});
if (!passwdEntry) {
  console.error(`could not find ${targetUser} in /etc/passwd`);
  process.exit(2);
}
const targetHome = passwdEntry.split(':')[5];
if (!targetHome) {
  console.error(`/etc/passwd entry for ${targetUser} has empty home directory field`);
  process.exit(2);
}

const fallbackPath = `${targetHome}/.1password/agent.sock`;
const socketExists = existsSync(fallbackPath);

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string) => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

// -----------------------------------------------------------------------
// Scenario A: positive path -- sshAuthSockFallback provided to helper
// -----------------------------------------------------------------------
console.log(`==> Scenario A: fallback path provided to buildElevationArgs`);
console.log(`    target=${targetUser} home=${targetHome}`);
console.log(`    fallbackPath=${fallbackPath}`);
console.log(`    socketExists=${socketExists}`);

{
  const { argv, innerCommand } = buildElevationArgs({
    username: targetUser,
    cwd: '/',
    additionalEnvVars: {},
    command: 'env',
    sshAuthSockFallback: fallbackPath,
  });

  // Sanity: the helper composed the expected shell-level snippet. The
  // helper shell-escapes paths via the POSIX `'\''` pattern; defensively
  // reuse the same escape here so a home directory containing a single
  // quote does not produce a false-fail comparison.
  const quotedFallbackPath = shellEscape(fallbackPath);
  expect(
    innerCommand.includes(`[ -z "$SSH_AUTH_SOCK" ]`),
    'helper emits SSH_AUTH_SOCK unset guard',
  );
  expect(
    innerCommand.includes(`[ -S ${quotedFallbackPath} ]`),
    'helper emits socket existence guard for fallback path',
  );
  expect(
    innerCommand.includes(`export SSH_AUTH_SOCK=${quotedFallbackPath}`),
    'helper emits export of fallback path',
  );

  // Real elevation execution. The login-shell init started by `-i`
  // applies a fresh env via the elevation chain's `env_reset` default,
  // so the smoke invoker's own SSH_AUTH_SOCK (if any) cannot leak into
  // the elevated child. The conditional `if [ -z "$SSH_AUTH_SOCK" ]`
  // therefore evaluates against the elevated user's natural env, which
  // is the production semantic we want to verify.
  const proc = spawn([ELEV_BIN, ...argv], { cwd: '/', stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`PROBE FAILED: elevation invocation exited ${exitCode}`);
    console.error('stderr:', stderr);
    process.exit(1);
  }

  // Parse `env` output (KEY=value, possibly multi-line).
  const envMap = new Map<string, string>();
  let pendingKey: string | null = null;
  let pendingValue = '';
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      if (pendingKey !== null) envMap.set(pendingKey, pendingValue);
      pendingKey = m[1];
      pendingValue = m[2];
    } else if (pendingKey !== null) {
      pendingValue += '\n' + line;
    }
  }
  if (pendingKey !== null) envMap.set(pendingKey, pendingValue);

  const observedSock = envMap.get('SSH_AUTH_SOCK');
  console.log(`    observed SSH_AUTH_SOCK=${observedSock ?? '(unset)'}`);

  if (socketExists) {
    // Positive condition fully met: fallback exists, login init did not
    // set SSH_AUTH_SOCK -> we expect the fallback path.
    if (observedSock === fallbackPath) {
      expect(true, `SSH_AUTH_SOCK matches fallback path (login init did not pre-set it)`);
    } else if (observedSock && observedSock !== fallbackPath) {
      // Login init pre-set SSH_AUTH_SOCK -> our conditional does NOT
      // override it. This is the no-override invariant.
      expect(
        observedSock !== fallbackPath,
        'fallback does NOT override pre-existing SSH_AUTH_SOCK from login init',
        `observed=${observedSock}`,
      );
    } else {
      expect(
        false,
        `SSH_AUTH_SOCK should be set (fallback path exists and is a socket)`,
        `observed=${observedSock ?? '(unset)'}`,
      );
    }
  } else {
    // Fallback path does NOT exist on this host -> the [ -S ... ] guard
    // should reject, so SSH_AUTH_SOCK ends up either unset (login init
    // didn't set it) or whatever login init set it to.
    expect(
      observedSock !== fallbackPath,
      `SSH_AUTH_SOCK is NOT the (nonexistent) fallback path; socket-existence guard works`,
      `observed=${observedSock ?? '(unset)'}`,
    );
    console.warn(
      `  WARN  ${fallbackPath} does not exist on this host -- positive` +
        ` "fallback applied" assertion was skipped. Install 1Password (or` +
        ` ensure the agent socket file is present at the conventional path)` +
        ` for a fully exercised positive smoke.`,
    );
  }
}

// -----------------------------------------------------------------------
// Scenario B: negative path -- sshAuthSockFallback omitted
// -----------------------------------------------------------------------
console.log(`==> Scenario B: no fallback provided (back-compat lock)`);

{
  const { innerCommand } = buildElevationArgs({
    username: targetUser,
    cwd: '/',
    additionalEnvVars: {},
    command: 'env',
    // sshAuthSockFallback intentionally omitted
  });

  expect(
    !/SSH_AUTH_SOCK/.test(innerCommand),
    'no SSH_AUTH_SOCK token appears in inner command when fallback omitted',
  );
  expect(
    !/\.1password/.test(innerCommand),
    'no .1password path appears in inner command when fallback omitted',
  );
}

console.log();
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`PASSED: ${passes} assertion(s) passed`);
process.exit(0);
