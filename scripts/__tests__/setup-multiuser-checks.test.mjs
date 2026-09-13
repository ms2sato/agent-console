import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(__dirname, '..', 'lib', 'setup-multiuser-checks.sh');
const NOT_EXECUTABLE_FIXTURE = resolve(__dirname, 'fixtures', 'assert-not-executable-check.sh');
const NOT_READABLE_FIXTURE = resolve(__dirname, 'fixtures', 'assert-not-readable-check.sh');
const ELEVATE_READABLE_FIXTURE = resolve(__dirname, 'fixtures', 'elevate-prints-readable.sh');
const ELEVATE_UNREADABLE_FIXTURE = resolve(__dirname, 'fixtures', 'elevate-prints-unreadable.sh');
const ELEVATE_FAILS_SILENTLY_FIXTURE = resolve(__dirname, 'fixtures', 'elevate-fails-silently.sh');
const ELEVATE_ABSENT = resolve(__dirname, 'fixtures', 'elevate-does-not-exist-for-test.sh');

// assert_unified_bun_executable is a pure, side-effect-free function split
// out of scripts/setup-multiuser-for-ubuntu.sh (Issue #1222 Ruling 2) so its
// fail-closed contract can be tested directly, without root and without
// running the full bootstrap script (which requires real root privilege for
// any non-dry-run path). The production script sources this same file, so
// there is no replication to drift.
//
// Both LIB and the fixture below are spawned as plain executables
// (spawnSync(file, args) -- no 'bash', no '-c', no shell command string at
// all). This is deliberate, not merely argv-separation: an earlier version
// passed LIB/path as `bash -c script bash "$LIB" "$path"` positional
// parameters, which IS the injection-safe pattern (values never re-parsed
// by the shell), but CodeQL's js/shell-command-injection-from-environment
// query still flagged it -- it flags any tainted value reaching a
// spawnSync call whose command is a shell interpreter, regardless of
// whether the value lands in the command string or a separate argv slot.
// Spawning the lib file directly via its own shebang (see the
// direct-invocation guard at the bottom of setup-multiuser-checks.sh)
// removes the shell-interpreter sink entirely.
function runAssert(path) {
  return spawnSync(LIB, [path], { encoding: 'utf-8' });
}

describe('setup-multiuser-checks: assert_unified_bun_executable (Issue #1222 fail-closed guard)', () => {
  it('fails closed (exit 1) with a diagnostic when the path does not exist', () => {
    const r = runAssert('/nonexistent/unified-bun-path-for-test');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error:');
    expect(r.stderr).toContain('/nonexistent/unified-bun-path-for-test');
    expect(r.stderr).toContain('missing or not executable');
    expect(r.stderr).toContain('Step 6b');
  });

  it('fails closed (exit 1) when the path exists but is not executable', () => {
    const r = spawnSync(NOT_EXECUTABLE_FIXTURE, [], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing or not executable');
  });

  it('succeeds (exit 0, no stderr) when the path exists and is executable', () => {
    const r = runAssert('/bin/true');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

// assert_readable_file (Issue #1668): a second fail-closed guard in the same
// lib file, split out for update-and-deploy-for-multiuser-ubuntu.sh's
// pre-`systemctl restart` check. Dispatched via an explicit
// `assert-readable-file` subcommand (not argument count) so the pre-existing
// no-subcommand invocation above keeps calling assert_unified_bun_executable
// unchanged.
function runAssertReadableFile(path, hint) {
  return spawnSync(LIB, ['assert-readable-file', path, hint], { encoding: 'utf-8' });
}

describe('setup-multiuser-checks: assert_readable_file (Issue #1668 fail-closed guard)', () => {
  it('fails closed (exit 1) with a diagnostic when the path does not exist', () => {
    const r = runAssertReadableFile('/nonexistent/unified-entry-path-for-test', 'run the copy step');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error:');
    expect(r.stderr).toContain('/nonexistent/unified-entry-path-for-test');
    expect(r.stderr).toContain('missing or not readable');
    expect(r.stderr).toContain('run the copy step');
  });

  it('fails closed (exit 1) when the path exists but is not readable', () => {
    const r = spawnSync(NOT_READABLE_FIXTURE, [], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing or not readable');
  });

  it('succeeds (exit 0, no stderr) when the path exists and is readable, without requiring the executable bit', () => {
    // /etc/hostname is world-readable and never executable on a standard
    // Linux install -- this is the case that distinguishes assert_readable_file
    // from assert_unified_bun_executable, which would fail this same path.
    const r = runAssertReadableFile('/etc/hostname', 'unused hint');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('does not dispatch to assert_readable_file for the pre-existing no-subcommand invocation (backward compatibility)', () => {
    // A plain readable, non-executable file must still fail the DEFAULT
    // (no-subcommand) dispatch, because that path is
    // assert_unified_bun_executable, which requires the executable bit.
    const r = runAssert('/etc/hostname');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing or not executable');
  });
});

// assert_readable_by_unprivileged_user (Issue #1668, elevated + re-read
// #1690): probes readability from `nobody`'s view via
// `<elevate> runuser -u nobody -- sh -c '...'`, reading the answer from a
// stdout marker (READABLE / UNREADABLE), never from the exit code -- #1673's
// original exit-code-based check misattributed an elevation refusal (the
// operator's own invocation is unprivileged; `runuser` itself needs root)
// to "not readable", which had nothing to do with file permissions.
//
// `<elevate>` is the THIRD argument, an explicit parameter never read from
// the environment (Issue #1690's whole point: #1673 called this "cannot be
// faked in a unit test" because it shelled out to bare `runuser` with no
// seam to substitute). Each fixture below stands in for `<elevate>` itself
// -- the function invokes it as `"$elevate" runuser -u nobody -- sh -c
// '...' _ "<path>"`, and the fixture ignores every one of those trailing
// arguments and just prints what a real elevation+runuser+sh -c chain would
// have produced in each scenario. This lets all four cases run with no real
// root and no real `runuser`.
function runAssertReadableByUnprivilegedUser(path, hint, elevate) {
  return spawnSync(
    LIB,
    ['assert-readable-by-unprivileged-user', path, hint, elevate],
    { encoding: 'utf-8' },
  );
}

describe('setup-multiuser-checks: assert_readable_by_unprivileged_user (Issue #1668 + #1690 elevated fail-closed guard)', () => {
  it('the runuser-missing guard still fires before any elevation is attempted', () => {
    // Strip only the directories that provide `runuser` (typically
    // /usr/sbin, /sbin) from PATH -- a fully empty PATH would also hide
    // `bash`/`env` themselves and fail the LIB script's own shebang lookup
    // (exit 127), which is a harness failure, not the guard this test
    // targets.
    const pathWithoutSbin = (process.env.PATH ?? '')
      .split(':')
      .filter((dir) => dir !== '/usr/sbin' && dir !== '/sbin')
      .join(':');
    const r = spawnSync(
      LIB,
      ['assert-readable-by-unprivileged-user', '/some/path', 'some hint', ELEVATE_READABLE_FIXTURE],
      { encoding: 'utf-8', env: { ...process.env, PATH: pathWithoutSbin } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('runuser (util-linux) not found');
  });

  it('case 1/4: elevate + runuser + test -r all succeed and print READABLE -> passes (exit 0, no stderr)', () => {
    const r = runAssertReadableByUnprivilegedUser(
      '/usr/local/lib/agent-console/embedded-agent.js',
      'unused hint',
      ELEVATE_READABLE_FIXTURE,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('case 2/4: the chain succeeds but the file itself is unreadable -> the real fail-closed gate (exit 1, "not readable")', () => {
    const r = runAssertReadableByUnprivilegedUser(
      '/some/unreadable/path',
      'step 5/6 did not complete',
      ELEVATE_UNREADABLE_FIXTURE,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not readable by an unprivileged user');
    expect(r.stderr).toContain('step 5/6 did not complete');
    // Distinct from case 3/4 below: this is the readability gate itself,
    // not a "probe could not run" mechanism failure.
    expect(r.stderr).not.toContain('could not run');
  });

  it('case 3/4: elevation is refused before runuser ever runs -> reported as a distinct "probe could not run" cause, not "not readable" (Issue #1690\'s actual bug)', () => {
    const r = runAssertReadableByUnprivilegedUser(
      '/usr/local/lib/agent-console/embedded-agent.js',
      'step 5/6 did not complete',
      ELEVATE_FAILS_SILENTLY_FIXTURE,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not run');
    // The underlying mechanism's own stderr is surfaced, not swallowed.
    expect(r.stderr).toContain('elevation refused (simulated)');
    // This is the exact misattribution Issue #1690 fixes: a mechanism
    // failure must never be reported as the readability verdict.
    expect(r.stderr).not.toContain('not readable by an unprivileged user');
  });

  it('case 4/4: the elevation prefix itself does not exist (exit 127) -> the same distinct "probe could not run" cause', () => {
    const r = runAssertReadableByUnprivilegedUser(
      '/usr/local/lib/agent-console/embedded-agent.js',
      'step 5/6 did not complete',
      ELEVATE_ABSENT,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not run');
    expect(r.stderr).not.toContain('not readable by an unprivileged user');
  });

  it('id -u = 0 shape: an empty elevate prefix disappears via unquoted word-splitting, so runuser itself runs (not an empty-string command)', () => {
    // The production caller passes an empty string when it is already root
    // (no elevation prefix needed). Confirm an empty third argument does not
    // become a spurious empty command-name argument that breaks the
    // invocation -- runuser itself is real here (not faked), so this
    // exercises the no-elevation path against a path this test process can
    // actually read without needing to actually switch to `nobody` (this
    // process is not root, so a REAL `runuser -u nobody` would itself be
    // refused -- which is exactly case 3/4 above, already covered with a
    // fixture; this case only needs to prove the empty argument disappears
    // from the command line rather than that runuser succeeds as non-root).
    const r = runAssertReadableByUnprivilegedUser('/etc/hostname', 'unused hint', '');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not run');
    // Measured (Architect review, PR #1697): quoting `${elevate}` as
    // `"$elevate"` instead of leaving it unquoted is a mutation this
    // assertion must catch, and a bare `toContain('could not run')` does
    // NOT catch it -- both the correct (unquoted) and the mutant (quoted)
    // shape produce empty stdout and a non-zero exit, so both fall into the
    // same "could not run" branch. The two are distinguishable only by
    // WHICH underlying mechanism produced that empty stdout: unquoted, the
    // empty string vanishes and `runuser` itself runs and refuses with its
    // own message; quoted, the empty string becomes a literal one-word
    // command name and the shell reports its own "command not found"
    // before `runuser` is ever reached. Both halves of this pin are
    // required -- asserting only the positive half would still pass if a
    // regression additionally started leaking "command not found" text
    // alongside a coincidental "may not be used" substring from elsewhere.
    expect(r.stderr).toContain('may not be used by non-root users');
    expect(r.stderr).not.toContain('command not found');
  });

  // Reach measurement (workflow.md "A check's existence is not its
  // detection power"): swap the marker-based verdict for an exit-code-based
  // one (the shape #1673 originally shipped) and confirm the "probe could
  // not run" case (fixture 3/4 above) collapses into "unreadable" -- the
  // exact misattribution #1690 exists to remove. `test -r ... || echo
  // UNREADABLE` always exits 0 on its own account (the `||` absorbs
  // `test`'s failure), so the ONLY way the overall chain can exit non-zero
  // is if elevation or `runuser` itself failed before the inner `sh -c` ever
  // ran -- meaning an exit-code check cannot tell "mechanism failed" apart
  // from "file is unreadable" at all: both are just "non-zero exit, no
  // information about which of the two happened".
  it('[reach measurement] the fails-silently fixture exits non-zero with empty stdout -- a bare exit-code check cannot distinguish it from "unreadable"', () => {
    const r = spawnSync(ELEVATE_FAILS_SILENTLY_FIXTURE, [], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    // The marker-based check above tells the two apart via this exact gap:
    // no READABLE/UNREADABLE marker on stdout at all. An exit-code-only
    // check has no equivalent signal and would report "not readable" here,
    // which is false -- the readability check never ran.
  });
});
