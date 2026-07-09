#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the login-shell sentinel PTY protocol.
 *
 * Spawns a REAL PTY running a REAL login shell using the same production
 * PtyProvider (`bunPtyProvider`) and the same shared command builders
 * (`buildDirectSentinelShellCommand` / `buildElevatedSentinelCommand`) that
 * `MultiUserMode` / `SingleUserMode` use. It then drives the full protocol:
 * wait for the sentinel line, inject a probe command into the interactive
 * shell that follows, and assert the observable end state.
 *
 * What this smoke exercises:
 *   - The production command builders (via direct import -- no hand copy).
 *   - The real login shell init (PATH / HOME / USER / SHELL) delivered by the
 *     login shell the sentinel command execs.
 *   - The one-shot sentinel contract: the sentinel is emitted exactly once,
 *     before the interactive shell, and command injection after the gate runs
 *     as the expected user.
 *   - (--elevated) the real OS elevation chain: real elevation binary, real
 *     sudoers config, target user's login shell init.
 *
 * What this smoke does NOT exercise:
 *   - The worker-manager's chunk-boundary sentinel gate (covered by the
 *     worker-manager unit tests). Here the raw PTY stream is inspected
 *     directly.
 *   - bun-pty's internal PTY allocation. That is a library concern.
 *   - The agent-console server. The builders are pure; no server runs here.
 *
 * Usage:
 *   bun scripts/smoke/check-login-shell-sentinel.ts               # direct mode
 *   bun scripts/smoke/check-login-shell-sentinel.ts --elevated <target-user>
 *
 * Requirements:
 *   - direct mode: a login shell resolvable via $SHELL for the current user.
 *   - --elevated mode: run as a user with elevation privilege for
 *     <target-user> (on the dogfood host, the agentconsole service user with
 *     the sudoers rules installed by scripts/setup-multiuser-for-ubuntu.sh).
 *     <target-user> must be a real OS user with a login shell.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  the protocol ran but an assertion failed (the system is wrong)
 *   2  bad usage, or the probe could not run at all (e.g. --elevated
 *      precondition not met: elevation not permitted / password required /
 *      target user absent). Distinct from 1 so operators can tell apart
 *      "the smoke ran and found a real problem" vs "the smoke could not run".
 *
 * Sync contract: NONE -- the production command builders and PtyProvider are
 * imported directly. Changing the spawn command shape in production updates
 * this smoke automatically because both paths call the same builders.
 */

import * as os from 'os';
import * as crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { PtyInstance } from '../../packages/server/src/lib/pty-provider.js';
import { bunPtyProvider } from '../../packages/server/src/lib/pty-provider.js';
import { getUnsetEnvPrefix } from '../../packages/server/src/services/env-filter.js';
import {
  buildDirectSentinelShellCommand,
  buildElevatedSentinelCommand,
} from '../../packages/server/src/services/sentinel-spawn-command.js';
import { buildElevationArgs } from '../../packages/server/src/services/elevation-args.js';

// Neutralize any unreadable inherited cwd (see check-multiuser-pty-env.ts):
// when invoked via an elevation wrapper the caller's cwd may be untraversable
// by the spawning user, producing EACCES at posix_spawn time. "/" is always
// world-traversable.
process.chdir('/');

const PHASE_TIMEOUT_MS = 15000;
const POLL_MS = 50;

// ---------- arg parsing ----------
const args = process.argv.slice(2);
let mode: 'direct' | 'elevated';
let targetUser = '';
if (args.length === 0) {
  mode = 'direct';
} else if (args[0] === '--elevated' && args[1]) {
  mode = 'elevated';
  targetUser = args[1];
} else {
  console.error('usage: bun scripts/smoke/check-login-shell-sentinel.ts [--elevated <target-user>]');
  process.exit(2);
}

// ---------- helpers ----------
function resolveBin(name: string, candidates: string[]): string {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  console.error(`could not find ${name} in any of: ${candidates.join(', ')}`);
  process.exit(2);
}

/** Best-effort target-user home lookup from /etc/passwd (WARN check only). */
function passwdHome(user: string): string {
  try {
    const entry = readFileSync('/etc/passwd', 'utf-8')
      .split('\n')
      .find((line) => {
        const idx = line.indexOf(':');
        return idx > 0 && line.slice(0, idx) === user;
      });
    return entry ? (entry.split(':')[5] ?? '') : '';
  } catch {
    return '';
  }
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

const sentinel = '__AGENT_CONSOLE_READY_SMOKE_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

// ---------- spawn per mode ----------
let pty: PtyInstance;
let expectedUser: string;
let expectedHome: string;

if (mode === 'direct') {
  const shellCommand = buildDirectSentinelShellCommand(sentinel, getUnsetEnvPrefix());
  pty = bunPtyProvider.spawn('sh', ['-c', shellCommand], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: '/',
    env: cleanEnv(),
  });
  expectedUser = os.userInfo().username;
  expectedHome = os.homedir();
} else {
  const SUDO_BIN = resolveBin('elevation binary', ['/usr/bin/sudo', '/bin/sudo']);
  const { argv } = buildElevationArgs({
    username: targetUser,
    cwd: '/',
    additionalEnvVars: {},
    command: buildElevatedSentinelCommand(sentinel),
  });
  pty = bunPtyProvider.spawn(SUDO_BIN, argv, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: '/',
  });
  expectedUser = targetUser;
  expectedHome = passwdHome(targetUser);
}

// ---------- drive the protocol ----------
let output = '';
let exited = false;
let childExitCode: number | null = null;
pty.onData((chunk) => {
  output += chunk;
});
pty.onExit(({ exitCode }) => {
  exited = true;
  childExitCode = exitCode;
});

async function waitFor(pred: () => boolean): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < PHASE_TIMEOUT_MS) {
    if (pred()) return true;
    if (exited) return pred();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return pred();
}

function finish(code: number): never {
  try {
    pty.kill();
  } catch {
    // best-effort cleanup; the child may already be gone
  }
  process.exit(code);
}

// Phase 1: wait for the sentinel line.
const sentinelSeen = await waitFor(() => output.includes(sentinel));
if (!sentinelSeen) {
  if (mode === 'elevated') {
    console.error('SKIP: sentinel never observed under elevation -- precondition not met.');
    if (exited) console.error(`  elevated child exited early with code ${childExitCode}`);
    console.error('  (elevation not permitted, a password is required, or the target user cannot log in)');
    console.error('  captured output (first 500 chars):');
    console.error(output.slice(0, 500));
    finish(2);
  }
  console.error('FAILED: login-shell sentinel never appeared within timeout.');
  console.error('  captured output (first 500 chars):');
  console.error(output.slice(0, 500));
  finish(1);
}

const sentinelIndex = output.indexOf(sentinel);
const preSentinel = output.slice(0, sentinelIndex);

// Phase 2: inject a probe into the interactive shell that follows the sentinel.
pty.write('echo SMOKE_MARKER_OK; whoami; echo "SMOKE_PATH=$PATH"\r');

const markerSeen = await waitFor(() => output.includes('SMOKE_MARKER_OK'));
if (!markerSeen) {
  console.error('FAILED: injected probe never produced its marker (command was not executed).');
  console.error('  captured output (first 800 chars):');
  console.error(output.slice(0, 800));
  finish(1);
}

// Wait for the probe's PATH line to flush (printed after the marker).
await waitFor(() =>
  output
    .split(/\r?\n/)
    .some((l) => {
      const t = l.trim();
      return t.startsWith('SMOKE_PATH=') && !t.includes('$PATH') && t.length > 'SMOKE_PATH='.length;
    }),
);

// ---------- assertions ----------
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

const lines = output.split(/\r?\n/).map((l) => l.trim());
const pathLine = lines.find((l) => l.startsWith('SMOKE_PATH=') && !l.includes('$PATH'));
const smokePath = pathLine ? pathLine.slice('SMOKE_PATH='.length) : '';

console.log(`==> login-shell sentinel protocol (${mode} mode)`);
expect(output.includes(sentinel), 'sentinel appeared in PTY output');
expect(
  output.indexOf('SMOKE_MARKER_OK') > sentinelIndex,
  'injected probe ran after the sentinel gate',
);
expect(
  lines.includes(expectedUser),
  `whoami reports the expected user (${expectedUser})`,
  `no output line equal to "${expectedUser}"`,
);
expect(smokePath.length > 0, 'PATH is non-empty in the injected shell', `got: ${smokePath || '(empty)'}`);

console.log('==> login-init PATH check');
if (expectedHome) {
  const includesHome = smokePath.split(':').some((p) => p === expectedHome || p.startsWith(`${expectedHome}/`));
  if (includesHome) {
    console.log(`  OK    PATH includes ${expectedHome} (login-init user tree)`);
    passes++;
  } else {
    console.warn(`  WARN  PATH does not include ${expectedHome} -- acceptable if the`);
    console.warn(`        user has no per-user bin tree, but if claude was installed`);
    console.warn(`        under their home it will not resolve.`);
  }
} else {
  console.warn('  WARN  could not resolve expected home; skipping login-init PATH check');
}

console.log('==> sentinel-gate negatives');
expect(!preSentinel.includes('SMOKE_MARKER'), 'no probe output leaked before the sentinel gate');
const afterGate = output.slice(sentinelIndex + sentinel.length);
expect(
  !afterGate.includes(sentinel),
  'sentinel is a one-shot marker (not repeated after the gate)',
);

console.log();
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} assertion(s) failed`);
  finish(1);
}
console.log(`PASSED: ${passes} assertion(s) passed`);
finish(0);
