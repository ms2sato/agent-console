#!/usr/bin/env bun
/**
 * Post-deploy smoke test for multi-user PTY env propagation.
 *
 * Runs the same `sudo` argv that production `MultiUserMode.spawnSudoPty`
 * builds, against the real machine, using the SHARED `buildElevationArgs`
 * helper imported from the production source. Because the helper is the
 * single source of truth (production AND this script call it identically),
 * drift between what production does and what smoke verifies is impossible
 * by construction.
 *
 * What this smoke exercises:
 *   - The production helper's argv shape (via direct import).
 *   - The real OS `sudo` binary, real sudoers config, real env_keep defaults.
 *   - The target user's login shell init (PATH / HOME / USER / SHELL / ...).
 *   - The actual env vars the elevated process sees after the chain.
 *
 * What this smoke does NOT exercise:
 *   - bun-pty's internal spawn behaviour (allocate PTY, set TERM via name,
 *     etc.). Those are bun-pty library concerns, exercised by the bun-pty
 *     tests and continuously by production.
 *   - The agent-console server itself. The helper is pure; the server is
 *     not running for this test.
 *
 * Usage:
 *   bun scripts/smoke/check-multiuser-pty-env.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with sudo privilege for <target-user>. On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (which has sudoers rules permitting `-u <interactive-user>` per
 *     scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (details on stderr)
 *   2  bad usage / cannot run
 *
 * Sync contract: NONE -- the production helper is imported directly. Adding
 * new env exports in production updates this smoke automatically because
 * both paths call `buildElevationArgs`. Issue #866 motivated this design.
 */

import { spawn } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { buildElevationArgs } from '../../packages/server/src/services/elevation-args.js';

const targetUser = process.argv[2];
if (!targetUser) {
  console.error('usage: bun scripts/smoke/check-multiuser-pty-env.ts <target-user>');
  process.exit(2);
}

// Resolve the elevation binary by absolute path. The invoking process's PATH
// cannot be trusted -- when the script is run via "... -u <service-account>",
// the inherited PATH may point to directories the service account cannot
// exec, producing surprising EACCES errors at posix_spawn time (observed
// during initial dogfood test of #866).
function resolveBin(name: string, candidates: string[]): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(`Could not find ${name} in any of: ${candidates.join(', ')}`);
}
const SUDO_BIN = resolveBin('elevation binary', ['/usr/bin/sudo', '/bin/sudo']);

// Resolve the target user's actual home from /etc/passwd directly. Reading
// /etc/passwd avoids spawning `getent` -- which on the initial dogfood run
// hit a Bun-side posix_spawn EACCES quirk specific to "... -u
// <service-account>" without a full login session. /etc/passwd is
// world-readable on standard Linux installs, and for this project's local-OS
// account model (no LDAP / NIS), reading it directly is functionally
// equivalent to getent.
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

// Use the production helper to build argv. command='env' makes the inner
// shell dump its env once login init has run, so we observe the actual env
// the elevated process sees.
const { argv } = buildElevationArgs({
  username: targetUser,
  cwd: '/',
  additionalEnvVars: {},
  // No agentConsoleVars: we're testing the terminal-worker shape (no agent
  // context). Validating those would add no machine-quirk coverage beyond
  // what the elevation-args unit tests cover.
  command: 'env',
});

// Real privilege-elevation invocation (absolute path; see resolveBin above).
const proc = spawn([SUDO_BIN, ...argv], { stdout: 'pipe', stderr: 'pipe' });
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
  console.error(`PROBE FAILED: sudo invocation exited ${exitCode}`);
  console.error('stderr:', stderr);
  process.exit(1);
}

// Parse `env` output (KEY=value per line) into a Map. `env` may emit
// multi-line values for some vars; we conservatively split on lines that
// start with a valid env-var name.
const envLines = stdout.split('\n');
const envMap = new Map<string, string>();
let pendingKey: string | null = null;
let pendingValue = '';
for (const line of envLines) {
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

console.log('==> color env (whitelist injected by buildElevationArgs)');
expect(envMap.get('TERM') === 'xterm-256color', 'TERM=xterm-256color', `got: ${envMap.get('TERM') ?? '(unset)'}`);
expect(envMap.get('COLORTERM') === 'truecolor', 'COLORTERM=truecolor', `got: ${envMap.get('COLORTERM') ?? '(unset)'}`);
expect(envMap.get('FORCE_COLOR') === '3', 'FORCE_COLOR=3', `got: ${envMap.get('FORCE_COLOR') ?? '(unset)'}`);

console.log('==> elevated user natural env (from sudo -i login shell init)');
expect(envMap.get('USER') === targetUser, `USER=${targetUser}`, `got: ${envMap.get('USER') ?? '(unset)'}`);
expect(envMap.get('LOGNAME') === targetUser, `LOGNAME=${targetUser}`, `got: ${envMap.get('LOGNAME') ?? '(unset)'}`);
expect(
  envMap.get('HOME') === targetHome,
  `HOME matches target account (${targetHome})`,
  `got: ${envMap.get('HOME') ?? '(unset)'}`,
);
expect((envMap.get('PATH') ?? '').length > 0, 'PATH is set', `got: ${envMap.get('PATH') ?? '(unset)'}`);
expect((envMap.get('SHELL') ?? '').length > 0, 'SHELL is set', `got: ${envMap.get('SHELL') ?? '(unset)'}`);

console.log("==> no bun-server env leak (target user's tree in PATH)");
const targetPath = envMap.get('PATH') ?? '';
const includesTargetHome = targetPath
  .split(':')
  .some((p) => p === targetHome || p.startsWith(`${targetHome}/`));
if (includesTargetHome) {
  console.log(`  OK    PATH includes ${targetHome} (target user's tree)`);
  passes++;
} else {
  console.warn(`  WARN  PATH does not include ${targetHome} -- this is`);
  console.warn(`        acceptable if the target user has no per-user bin tree`);
  console.warn(`        configured, but if claude was installed under their`);
  console.warn(`        home (npm global / nvm typical), claude will not`);
  console.warn(`        resolve. Verify with:`);
  console.warn(`          sudo -u ${targetUser} -i which claude`);
}

console.log();
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`PASSED: ${passes} assertion(s) passed`);
process.exit(0);
