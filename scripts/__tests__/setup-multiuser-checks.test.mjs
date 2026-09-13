import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(__dirname, '..', 'lib', 'setup-multiuser-checks.sh');
const NOT_EXECUTABLE_FIXTURE = resolve(__dirname, 'fixtures', 'assert-not-executable-check.sh');
const NOT_READABLE_FIXTURE = resolve(__dirname, 'fixtures', 'assert-not-readable-check.sh');

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
