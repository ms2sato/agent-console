import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
    // invocation.
    //
    // CodeRabbit review (PR #1697) on an earlier version of this test: it
    // called the REAL `runuser` and asserted util-linux's own "may not be
    // used by non-root users" diagnostic, which assumes the test process is
    // non-root -- on a root CI runner, real `runuser -u nobody` SUCCEEDS
    // (root can switch to any user), so the whole test would fail there
    // regardless of whether the production code is correct. Fixed by
    // shadowing `runuser` with a fake fixture (same pattern as the
    // ELEVATE_* fixtures above, just resolved via PATH instead of passed as
    // the `elevate` argument), independent of the test process's own UID
    // and of util-linux's exact wording.
    const fakeRunuserDir = mkdtempSync(join(tmpdir(), 'fake-runuser-'));
    try {
      writeFileSync(
        join(fakeRunuserDir, 'runuser'),
        '#!/usr/bin/env bash\necho "FAKE_RUNUSER_INVOKED argv=$*" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const r = spawnSync(
        LIB,
        ['assert-readable-by-unprivileged-user', '/etc/hostname', 'unused hint', ''],
        { encoding: 'utf-8', env: { ...process.env, PATH: `${fakeRunuserDir}:${process.env.PATH}` } },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not run');
      // The fake only runs at all if PATH resolution found a command
      // literally named `runuser` -- proving the empty `elevate` argument
      // vanished via word-splitting rather than becoming argv[0] itself.
      expect(r.stderr).toContain('FAKE_RUNUSER_INVOKED argv=-u nobody --');
      // Measured (Architect review, PR #1697): quoting `${elevate}` as
      // `"$elevate"` instead of leaving it unquoted is a mutation this
      // assertion must catch, and a bare `toContain('could not run')` does
      // NOT catch it -- both the correct (unquoted) and the mutant (quoted)
      // shape produce empty stdout and a non-zero exit, so both fall into
      // the same "could not run" branch. The two are distinguishable only
      // by WHICH command actually ran: unquoted, the empty string vanishes
      // and the fake `runuser` above runs and prints its marker; quoted,
      // the empty string becomes a literal one-word command name and the
      // shell reports its own "command not found" *before* anything named
      // `runuser` is ever reached -- the fake is never invoked, so its
      // marker is absent. Both halves of this pin are required -- asserting
      // only the positive half would still pass if a regression
      // additionally started leaking "command not found" text alongside a
      // coincidental marker from elsewhere.
      expect(r.stderr).not.toContain('command not found');
    } finally {
      rmSync(fakeRunuserDir, { recursive: true, force: true });
    }
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

// dist_artifact_present (Issue #1707): the mode decision Step 8 of
// setup-multiuser-for-ubuntu.sh uses to avoid `enable --now`ing a unit whose
// dist/index.js does not exist yet -- that manufactures a crash loop under
// Restart=on-failure on a fresh host (measured in
// docs/design/elevation-verification-tiers.md Task 0 S2, both runs:
// NRestarts climbing every 5s, Result=exit-code). A pure predicate over an
// arbitrary path, so it needs no service user / root, unlike Step 8 itself.
function runDistArtifactPresent(distIndexPath) {
  return spawnSync(LIB, ['dist-artifact-present', distIndexPath], { encoding: 'utf-8' });
}

describe('setup-multiuser-checks: dist_artifact_present (Issue #1707 pre-enable-now guard)', () => {
  it('present branch: exits 0 with no stderr when dist/index.js exists', () => {
    // Any existing file stands in for dist/index.js -- the function only
    // checks `-f`, not content.
    const r = runDistArtifactPresent('/bin/true');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('absent branch: exits 1 and prints the exact build-first remedy message when dist/index.js does not exist', () => {
    const r = runDistArtifactPresent('/nonexistent/dist/index.js');
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(
      'built artifact absent -- run scripts/update-and-deploy-for-multiuser-ubuntu.sh once to build and start the unit',
    );
  });

  // Polarity (workflow.md TDD requirement, applied as a new-mechanism
  // contract per testing.md's category table: this mechanism did not exist
  // before Issue #1707, so both branches must fail against the pre-fix
  // script). Measured by hand against the pre-fix
  // scripts/lib/setup-multiuser-checks.sh (git show HEAD before this PR's
  // commit, i.e. the version with no `dist-artifact-present` subcommand and
  // no `dist_artifact_present` function): the unrecognized subcommand name
  // falls through to the dispatcher's default case, which forwards it as
  // the bun-path argument to assert_unified_bun_executable. Both the
  // present-file and absent-file cases produced exit 1 with the UNRELATED
  // Issue #1222 "unified bun binary ... is missing or not executable"
  // message (naming the literal string "dist-artifact-present" as the
  // missing path, not the file argument at all) -- neither the present
  // branch's "exit 0, no stderr" contract nor the absent branch's exact
  // remedy message existed pre-fix. Both tests above therefore flip
  // polarity: they fail against unmodified code and pass against the fix.
});

// ---------------------------------------------------------------------------
// Post-deploy verification checks V1-V6 (Issue #1717, absorbing #1688).
//
// Each check is a named subcommand of the same lib, pure over its inputs:
// every external command it needs (systemctl / journalctl / curl / the
// elevation prefix) is an explicit argument, faked here by the static
// fixtures under fixtures/ (fake-systemctl.sh, fake-journalctl.sh,
// fake-curl.sh, fake-elevate-identity.sh) whose canned answers come from
// environment variables on the child process -- the #1690 seam, applied to
// every check that shells out. No real systemd, journal, server or root is
// touched by anything in this section.
//
// Shared contract under test: exit 0 = PASS, 1 = FAIL (the check ran and the
// system is wrong), 2 = cannot run (a mechanism failure); stdout line 1 is a
// machine-readable marker; stderr carries the human reason.
//
// Polarity, measured once for all six (workflow.md TDD requirement, applied
// as a new-mechanism contract, the same measurement #1707's
// dist_artifact_present recorded above): against the pre-fix lib (`git show
// HEAD:scripts/lib/setup-multiuser-checks.sh` before this PR's commit, which
// has none of these subcommands), every one of the six subcommand names
// falls through the dispatcher's default case into
// assert_unified_bun_executable, which reports `unified bun binary
// '<subcommand-name>' is missing or not executable` on stderr with exit 1
// and NO marker on stdout -- so every PASS-shaped assertion below (exit 0 +
// marker) and every cannot-run assertion (exit 2) fails pre-fix, and the
// FAIL-shaped ones fail on their marker / message assertions. All six were
// run by hand with the same fixtures and produced exactly that output.
// ---------------------------------------------------------------------------

const TEMPLATE = resolve(__dirname, '..', 'agent-console-multiuser.service.template');
const FAKE_SYSTEMCTL = resolve(__dirname, 'fixtures', 'fake-systemctl.sh');
const FAKE_JOURNALCTL = resolve(__dirname, 'fixtures', 'fake-journalctl.sh');
const FAKE_CURL = resolve(__dirname, 'fixtures', 'fake-curl.sh');
const FAKE_ELEVATE_IDENTITY = resolve(__dirname, 'fixtures', 'fake-elevate-identity.sh');
const UNIT = 'agent-console.service';

// The nine template keys, rendered the way `systemctl show -p Environment
// --value` prints a fully re-rendered unit (space-separated KEY=VALUE tokens,
// drop-ins already merged).
const LIVE_ENV_ALL_KEYS = [
  'PATH=/home/agentconsole/.bun/bin:/usr/local/bin:/usr/bin:/bin',
  'AUTH_MODE=multi-user',
  'AGENT_CONSOLE_HOME=/var/lib/agent-console',
  'PORT=8080',
  'HOST=0.0.0.0',
  'NODE_ENV=production',
  'AUTH_COOKIE_SECURE=false',
  'EMBEDDED_AGENT_BUN_PATH=/usr/local/bin/bun',
  'EMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js',
].join(' ');
const EXECSTART_UNIFIED =
  '{ path=/usr/local/bin/bun ; argv[]=/usr/local/bin/bun run start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
const EXECSTART_DRIFTED =
  '{ path=/home/agentconsole/.bun/bin/bun ; argv[]=/home/agentconsole/.bun/bin/bun run start ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';

function runLib(args, env = {}) {
  return spawnSync(LIB, args, { encoding: 'utf-8', env: { ...process.env, ...env } });
}

function markerOf(r) {
  return r.stdout.split('\n')[0];
}

describe('setup-multiuser-checks: unit-env-drift (V1, Issue #1688 fail-closed drift detection)', () => {
  const v1 = (env) => runLib(['unit-env-drift', TEMPLATE, UNIT, FAKE_SYSTEMCTL], env);

  it('reads its key set from the template itself: every ^Environment=KEY= line, nine today', () => {
    // Guards the "no maintained list" property: a future template key is
    // picked up because the CHECK reads the template, not a hardcoded array.
    // If the template's key set changes, LIVE_ENV_ALL_KEYS above must follow.
    const templateKeys = readFileSync(TEMPLATE, 'utf-8')
      .split('\n')
      .map((l) => l.match(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=/))
      .filter(Boolean)
      .map((m) => m[1]);
    expect(templateKeys).toEqual([
      'PATH', 'AUTH_MODE', 'AGENT_CONSOLE_HOME', 'PORT', 'HOST', 'NODE_ENV',
      'AUTH_COOKIE_SECURE', 'EMBEDDED_AGENT_BUN_PATH', 'EMBEDDED_AGENT_ENTRY_PATH',
    ]);
  });

  it('all template keys present + ExecStart on the unified bun -> DRIFT_NONE, exit 0, no stderr, live KEY=VALUE lines on stdout', () => {
    const r = v1({ FAKE_ENVIRONMENT: LIVE_ENV_ALL_KEYS, FAKE_EXECSTART: EXECSTART_UNIFIED });
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('DRIFT_NONE');
    expect(r.stderr).toBe('');
    // The single read is passed down: the caller extracts V3's
    // <configured-bun> from these lines instead of reading systemctl again.
    expect(r.stdout).toContain('\nEMBEDDED_AGENT_BUN_PATH=/usr/local/bin/bun\n');
    expect(r.stdout).toContain('\nEMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js\n');
  });

  it('one template key missing from the live environment -> DRIFT_MISSING naming it, exit 1, and BOTH remedies (setup --dry-run/--force, and a .service.d drop-in)', () => {
    const withoutEntryPath = LIVE_ENV_ALL_KEYS.replace(
      ' EMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js', '',
    );
    const r = v1({ FAKE_ENVIRONMENT: withoutEntryPath, FAKE_EXECSTART: EXECSTART_UNIFIED });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('DRIFT_MISSING:EMBEDDED_AGENT_ENTRY_PATH');
    expect(r.stderr).toContain('EMBEDDED_AGENT_ENTRY_PATH');
    expect(r.stderr).toContain('never re-rendered');
    expect(r.stderr).toContain('setup-multiuser-for-ubuntu.sh --dry-run');
    expect(r.stderr).toContain('--force');
    expect(r.stderr).toContain('agent-console.service.d/*.conf drop-in');
    // The deploy script never renders the unit (single writer = setup).
    expect(r.stderr).toContain('never renders the unit');
  });

  it('several missing keys are all named, comma-separated, in template order', () => {
    const r = v1({ FAKE_ENVIRONMENT: 'PATH=/x AUTH_MODE=multi-user PORT=8080', FAKE_EXECSTART: EXECSTART_UNIFIED });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe(
      'DRIFT_MISSING:AGENT_CONSOLE_HOME,HOST,NODE_ENV,AUTH_COOKIE_SECURE,EMBEDDED_AGENT_BUN_PATH,EMBEDDED_AGENT_ENTRY_PATH',
    );
  });

  it('a key supplied only by a drop-in counts as present (the fake prints the MERGED Environment= line, which is what `systemctl show` does)', () => {
    // The check reads the EFFECTIVE environment, so where a key came from
    // (the unit file or a .service.d drop-in) is invisible to it -- this is
    // what makes the drop-in a valid #1688 bridge remedy. Modelled by
    // appending the key at the END of the merged token list, out of
    // template order, the way a drop-in's Environment= lands after the
    // unit file's own.
    const dropInLast =
      LIVE_ENV_ALL_KEYS.replace(' EMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js', '') +
      ' EMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js';
    const r = v1({ FAKE_ENVIRONMENT: dropInLast, FAKE_EXECSTART: EXECSTART_UNIFIED });
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('DRIFT_NONE');
  });

  it('ExecStart running a binary other than EMBEDDED_AGENT_BUN_PATH (both rendered from {{BUN_PATH}}) -> DRIFT_EXECSTART as a WARN, exit 0, naming V3 as the hard gate', () => {
    const r = v1({ FAKE_ENVIRONMENT: LIVE_ENV_ALL_KEYS, FAKE_EXECSTART: EXECSTART_DRIFTED });
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('DRIFT_EXECSTART');
    expect(r.stderr).toMatch(/^WARN: /);
    expect(r.stderr).toContain('/home/agentconsole/.bun/bin/bun');
    expect(r.stderr).toContain("EMBEDDED_AGENT_BUN_PATH='/usr/local/bin/bun'");
    expect(r.stderr).toContain('V3 (mainpid-identity) is where this becomes a hard FAIL');
  });

  it('a missing key wins over ExecStart drift: exit 1 with DRIFT_MISSING, the WARN is not the verdict', () => {
    const r = v1({ FAKE_ENVIRONMENT: 'PATH=/x', FAKE_EXECSTART: EXECSTART_DRIFTED });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toMatch(/^DRIFT_MISSING:/);
    expect(r.stderr).not.toContain('WARN:');
  });

  it('systemctl failing -> cannot run (exit 2) with its stderr attached, never a drift verdict', () => {
    const r = v1({ FAKE_SYSTEMCTL_FAIL: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('cannot run');
    expect(r.stderr).toContain('fake-systemctl: failed (simulated)');
  });

  it('systemctl absent -> cannot run (exit 2)', () => {
    const r = runLib(['unit-env-drift', TEMPLATE, UNIT, '/nonexistent/systemctl-for-test']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
    expect(r.stderr).toContain('/nonexistent/systemctl-for-test');
  });

  it('a unit systemd does not know (LoadState=not-found) -> cannot run, pointing at the setup script, not "every key missing"', () => {
    const r = v1({ FAKE_LOADSTATE: 'not-found', FAKE_ENVIRONMENT: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not loaded');
    expect(r.stderr).toContain('setup-multiuser-for-ubuntu.sh');
  });

  it('a missing or unreadable template -> cannot run (exit 2)', () => {
    const r = runLib(['unit-env-drift', '/nonexistent/template-for-test', UNIT, FAKE_SYSTEMCTL]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('/nonexistent/template-for-test');
  });
});

describe('setup-multiuser-checks: entry-path-readable (V2, the #1668/#1690 probe on both unified paths, three-way)', () => {
  const v2 = (elevate) =>
    runLib(['entry-path-readable', '/usr/local/lib/agent-console/embedded-agent.js', '/usr/local/lib/agent-console/embedded-agent.js.map', elevate]);

  it('READABLE for both files -> exit 0, marker READABLE, no stderr', () => {
    const r = v2(ELEVATE_READABLE_FIXTURE);
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('READABLE');
    expect(r.stderr).toBe('');
  });

  it('UNREADABLE -> exit 1 (the real gate), marker names the path, stderr names the unprivileged-user cause', () => {
    const r = v2(ELEVATE_UNREADABLE_FIXTURE);
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('UNREADABLE:/usr/local/lib/agent-console/embedded-agent.js');
    expect(r.stderr).toContain('not readable by an unprivileged user');
    expect(r.stderr).not.toContain('could not run');
  });

  it('elevation refused before runuser ran -> exit 2 (cannot run), never "unreadable" -- the #1690 distinction, now as a distinct exit code', () => {
    const r = v2(ELEVATE_FAILS_SILENTLY_FIXTURE);
    expect(r.status).toBe(2);
    expect(markerOf(r)).toBe('PROBE_FAILED:/usr/local/lib/agent-console/embedded-agent.js');
    expect(r.stderr).toContain('could not run');
    expect(r.stderr).toContain('elevation refused (simulated)');
    expect(r.stderr).not.toContain('not readable by an unprivileged user');
  });

  it('runuser absent -> exit 2 naming util-linux (the existing guard, through the shared probe)', () => {
    const pathWithoutSbin = (process.env.PATH ?? '')
      .split(':')
      .filter((dir) => dir !== '/usr/sbin' && dir !== '/sbin')
      .join(':');
    const r = spawnSync(
      LIB,
      ['entry-path-readable', '/a', '/b', ELEVATE_READABLE_FIXTURE],
      { encoding: 'utf-8', env: { ...process.env, PATH: pathWithoutSbin } },
    );
    expect(r.status).toBe(2);
    expect(markerOf(r)).toBe('NO_RUNUSER');
    expect(r.stderr).toContain('runuser (util-linux) not found');
  });
});

describe('setup-multiuser-checks: mainpid-identity (V3, the running binary vs EMBEDDED_AGENT_BUN_PATH via the production compareBinaryIdentity)', () => {
  const v3 = (env, configured = '/usr/local/bin/bun') =>
    runLib(['mainpid-identity', UNIT, configured, FAKE_ELEVATE_IDENTITY, FAKE_SYSTEMCTL], env);

  // The marker-to-verdict table, pinned: this is the unit-level pin the AC
  // names in place of a tier-3 DIFFERENT arm (which would need a second bun
  // binary).
  const table = [
    ['SAME', 0, 'SAME', null],
    ['DIFFERENT', 1, 'DIFFERENT', 'runs a binary other than the one the embedded agent will spawn'],
    ['UNRESOLVABLE:self', 2, 'UNRESOLVABLE:self', 'even as the unit\'s own User=agentconsole AND Group=agent-console-users'],
    ['UNRESOLVABLE:configured', 2, 'UNRESOLVABLE:configured', 'could not be resolved as agentconsole:agent-console-users'],
    ['UNRESOLVABLE:bare', 2, 'UNRESOLVABLE:bare', 'bare EMBEDDED_AGENT_BUN_PATH'],
    ['', 2, 'NO_MARKER', 'no identity marker was produced'],
  ];
  for (const [marker, exit, expectedMarker, stderrNeedle] of table) {
    it(`entry marker '${marker || '(empty)'}' -> exit ${exit}, marker ${expectedMarker}`, () => {
      const r = v3({ FAKE_IDENTITY_MARKER: marker });
      expect(r.status).toBe(exit);
      expect(markerOf(r)).toBe(expectedMarker);
      if (stderrNeedle === null) {
        expect(r.stderr).toBe('');
      } else {
        expect(r.stderr).toContain(stderrNeedle);
      }
    });
  }

  it('DIFFERENT names the #1688 failure shape and the re-render remedy', () => {
    const r = v3({ FAKE_IDENTITY_MARKER: 'DIFFERENT' });
    expect(r.stderr).toContain('#1688');
    expect(r.stderr).toContain('setup-multiuser-for-ubuntu.sh --dry-run then --force');
  });

  it('runs the identity entry as the unit\'s User= AND Group= (the PTRACE_MODE_READ gap), with the configured bun as the interpreter and the sibling entry path', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v3-argv-')), 'argv.log');
    try {
      const r = v3({ FAKE_IDENTITY_MARKER: 'SAME', FAKE_ARGV_LOG: log, FAKE_USER: 'svc', FAKE_GROUP: 'shared', FAKE_MAINPID: '4242' });
      expect(r.status).toBe(0);
      const entry = resolve(__dirname, '..', 'lib', 'embedded-agent-bun-identity.ts');
      expect(readFileSync(log, 'utf-8').trim()).toBe(
        `runuser -u svc -g shared -- /usr/local/bin/bun ${entry} 4242 /usr/local/bin/bun`,
      );
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('MainPID=0 -> cannot run (exit 2), the entry is never invoked', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v3-argv-')), 'argv.log');
    try {
      const r = v3({ FAKE_IDENTITY_MARKER: 'SAME', FAKE_ARGV_LOG: log, FAKE_MAINPID: '0' });
      expect(r.status).toBe(2);
      expect(markerOf(r)).toBe('MAINPID_0');
      expect(r.stderr).toContain('no main process');
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('a bare configured value short-circuits to UNRESOLVABLE:bare (exit 2) without elevating', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v3-argv-')), 'argv.log');
    try {
      const r = v3({ FAKE_IDENTITY_MARKER: 'SAME', FAKE_ARGV_LOG: log }, 'bun');
      expect(r.status).toBe(2);
      expect(markerOf(r)).toBe('UNRESOLVABLE:bare');
      expect(r.stderr).toContain("bare name 'bun'");
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('elevation refused -> exit 2 with the refusal attached (NO_MARKER), never DIFFERENT', () => {
    const r = v3({ FAKE_ELEVATE_REFUSE: '1' });
    expect(r.status).toBe(2);
    expect(markerOf(r)).toBe('NO_MARKER');
    expect(r.stderr).toContain('elevation refused (simulated)');
  });

  it('systemctl failing / absent -> cannot run (exit 2)', () => {
    expect(v3({ FAKE_SYSTEMCTL_FAIL: '1' }).status).toBe(2);
    const absent = runLib(['mainpid-identity', UNIT, '/usr/local/bin/bun', FAKE_ELEVATE_IDENTITY, '/nonexistent/systemctl-for-test']);
    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain('cannot run');
  });
});

describe('setup-multiuser-checks: unit-active (V4)', () => {
  const v4 = (env) => runLib(['unit-active', UNIT, FAKE_SYSTEMCTL, FAKE_JOURNALCTL, ''], env);

  it('active -> exit 0, marker ACTIVE, no stderr', () => {
    const r = v4({});
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('ACTIVE');
    expect(r.stderr).toBe('');
  });

  it('any other state -> exit 1 naming the state, with systemctl status (10 lines) and the last 20 journal lines attached', () => {
    const r = v4({ FAKE_ACTIVE_STATE: 'failed', FAKE_JOURNAL_LINES: 'journal line A\njournal line B' });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('NOT_ACTIVE:failed');
    expect(r.stderr).toContain("'agent-console.service' is 'failed', not 'active'");
    expect(r.stderr).toContain('fake-systemctl status line 10');
    // The fixture prints 12 status lines; the check attaches 10.
    expect(r.stderr).not.toContain('fake-systemctl status line 11');
    expect(r.stderr).toContain('journal line A');
    expect(r.stderr).toContain('journal line B');
  });

  it('systemctl present but unable to answer (no state) -> cannot run (exit 2), not a FAIL', () => {
    const r = v4({ FAKE_SYSTEMCTL_NO_STATE: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
    expect(r.stderr).toContain('System has not been booted with systemd (simulated)');
  });

  it('systemctl absent -> cannot run (exit 2)', () => {
    const r = runLib(['unit-active', UNIT, '/nonexistent/systemctl-for-test']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
  });
});

describe('setup-multiuser-checks: health (V5, GET /api/config replacing the /api/auth/me probe)', () => {
  const v5 = (env, attempts = '1') => runLib(['health', '8080', attempts, FAKE_CURL], env);

  it('HTTP 200 with "authMode":"multi-user" -> exit 0, HEALTH_OK, and the URL is /api/config on the given port', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v5-argv-')), 'argv.log');
    try {
      const r = v5({ FAKE_CURL_STATUS: '200', FAKE_CURL_BODY: '{"serverPort":8080,"authMode":"multi-user"}', FAKE_ARGV_LOG: log });
      expect(r.status).toBe(0);
      expect(markerOf(r)).toBe('HEALTH_OK');
      expect(r.stderr).toBe('');
      expect(readFileSync(log, 'utf-8')).toContain('http://localhost:8080/api/config');
      expect(readFileSync(log, 'utf-8')).not.toContain('/api/auth/me');
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('HTTP 200 with another authMode -> exit 1 naming both the status and the mode', () => {
    const r = v5({ FAKE_CURL_STATUS: '200', FAKE_CURL_BODY: '{"authMode":"none"}' });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('HEALTH_WRONG_MODE:none');
    expect(r.stderr).toContain('HTTP 200');
    expect(r.stderr).toContain("authMode is 'none', not 'multi-user'");
  });

  it('a non-200 status -> exit 1 naming the status, after the requested number of attempts', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v5-argv-')), 'argv.log');
    try {
      const r = v5({ FAKE_CURL_STATUS: '503', FAKE_CURL_BODY: 'unavailable', FAKE_ARGV_LOG: log }, '2');
      expect(r.status).toBe(1);
      expect(markerOf(r)).toBe('HEALTH_HTTP:503');
      expect(r.stderr).toContain('HTTP 503');
      expect(r.stderr).toContain('after 2 attempt(s)');
      expect(readFileSync(log, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('no response at all (curl exit 7, code 000) -> exit 1, HEALTH_HTTP:000', () => {
    const r = v5({ FAKE_CURL_STATUS: '000' });
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('HEALTH_HTTP:000');
    expect(r.stderr).toContain('000 = no response');
  });

  it('curl absent -> cannot run (exit 2)', () => {
    const r = runLib(['health', '8080', '1', '/nonexistent/curl-for-test']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
  });
});

describe('setup-multiuser-checks: journal-digest (V6, the three boot lines and the bun-path warning)', () => {
  const SINCE = '2026-09-17 00:47:49';
  // The `-o cat` shape of the real journal, copied from the tier-3 run
  // (docs/design/elevation-verification-tiers.md, run 35167941294): the
  // server's pino JSON lines, message text only.
  const STARTING = '{"level":30,"time":1789606070057,"pid":554,"hostname":"h","service":"server","port":8080,"env":"production","pid":554,"msg":"Server starting"}';
  const COOKIE = '{"level":40,"time":1789606070057,"pid":554,"hostname":"h","service":"server","msg":"AUTH_COOKIE_SECURE=false disables the Secure attribute on the auth cookie while NODE_ENV=production. The session cookie will be transmitted over plain HTTP."}';
  const USER_MODE = '{"level":30,"time":1789606070060,"pid":554,"hostname":"h","service":"server","authMode":"multi-user","ptyProvider":"bun","msg":"User mode initialized"}';
  const LISTENING = '{"level":30,"time":1789606070061,"pid":554,"hostname":"h","service":"server","port":8080,"msg":"Server listening"}';
  // The real assessEmbeddedAgentBunPath warning texts (packages/server/src/lib/
  // embedded-agent-bun-path-check.ts): the 'different' one and the 'self' one
  // (the only one of the five that does not carry the EMBEDDED_AGENT_BUN_PATH
  // literal).
  const BUN_WARN_DIFFERENT = '{"level":40,"time":1789606070058,"pid":554,"hostname":"h","service":"server","msg":"EMBEDDED_AGENT_BUN_PATH is configured to \'/usr/local/bin/bun\', which is a different binary than the server\'s own executable (\'/home/agentconsole/.bun/bin/bun\'). An embedded-agent worker spawned via elevation would run a different bun than the server itself -- re-run scripts/setup-multiuser-for-ubuntu.sh, or set Environment=EMBEDDED_AGENT_BUN_PATH= in the unit to the same binary the server itself runs."}';
  const BUN_WARN_SELF = '{"level":40,"time":1789606070058,"pid":554,"hostname":"h","service":"server","msg":"Could not resolve the server\'s own running binary \'/proc/self/exe\': ENOENT; the embedded-agent bun-path identity check could not run at all. This is not a problem with the configured bun path value -- it is the server process\'s own executable that could not be resolved."}';
  const v6 = (lines, env = {}) =>
    runLib(['journal-digest', UNIT, SINCE, FAKE_JOURNALCTL, ''], { FAKE_JOURNAL_LINES: lines, ...env });

  it('all three boot lines present, no bun-path warning -> exit 0, JOURNAL_OK, and the since-timestamp reached journalctl', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'v6-argv-')), 'argv.log');
    try {
      const r = v6([STARTING, USER_MODE, LISTENING].join('\n'), { FAKE_ARGV_LOG: log });
      expect(r.status).toBe(0);
      expect(markerOf(r)).toBe('JOURNAL_OK');
      expect(r.stderr).toBe('');
      expect(readFileSync(log, 'utf-8').trim()).toBe(`-u ${UNIT} --since ${SINCE} -o cat --no-pager`);
    } finally {
      rmSync(dirname(log), { recursive: true, force: true });
    }
  });

  it('the AUTH_COOKIE_SECURE=false warning -> still exit 0 (JOURNAL_OK) with an INFO annotation, never FAIL', () => {
    const r = v6([STARTING, COOKIE, USER_MODE, LISTENING].join('\n'));
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('JOURNAL_OK');
    expect(r.stderr).toMatch(/^INFO: AUTH_COOKIE_SECURE=false/);
    expect(r.stderr).toContain('not a fault');
  });

  it('a required line absent -> exit 1 naming each absent line', () => {
    const r = v6([STARTING, USER_MODE].join('\n'));
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('JOURNAL_MISSING:Server listening');
    expect(r.stderr).toContain('Server listening');
  });

  it('"Server starting" without env: production, or "User mode initialized" without authMode multi-user, counts as absent', () => {
    const dev = STARTING.replace('"env":"production"', '"env":"development"');
    const single = USER_MODE.replace('"authMode":"multi-user"', '"authMode":"none"');
    const r = v6([dev, single, LISTENING].join('\n'));
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('JOURNAL_MISSING:Server starting (env: production);User mode initialized (authMode: multi-user)');
  });

  it('an empty journal since the timestamp -> exit 1 with all three lines named', () => {
    const r = v6('');
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('JOURNAL_MISSING:Server starting (env: production);User mode initialized (authMode: multi-user);Server listening');
  });

  it('an EMBEDDED_AGENT_BUN_PATH warning from assessEmbeddedAgentBunPath -> exit 1 (the unit\'s bun and the embedded agent\'s bun still differ), warning text attached', () => {
    const r = v6([STARTING, BUN_WARN_DIFFERENT, USER_MODE, LISTENING].join('\n'));
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('JOURNAL_BUN_PATH_WARNING');
    expect(r.stderr).toContain('still differ');
    expect(r.stderr).toContain('which is a different binary');
  });

  it('the "self" warning (no EMBEDDED_AGENT_BUN_PATH literal in its text) is matched on its real wording too', () => {
    const r = v6([STARTING, BUN_WARN_SELF, USER_MODE, LISTENING].join('\n'));
    expect(r.status).toBe(1);
    expect(markerOf(r)).toBe('JOURNAL_BUN_PATH_WARNING');
  });

  it('the literal EMBEDDED_AGENT_BUN_PATH on a non-warn line (e.g. an info line quoting the config) is NOT a warning', () => {
    const infoMention = '{"level":30,"pid":554,"msg":"config: EMBEDDED_AGENT_BUN_PATH=/usr/local/bin/bun"}';
    const r = v6([STARTING, infoMention, USER_MODE, LISTENING].join('\n'));
    expect(r.status).toBe(0);
    expect(markerOf(r)).toBe('JOURNAL_OK');
  });

  it('journalctl failing -> cannot run (exit 2) with its stderr attached', () => {
    const r = v6('', { FAKE_JOURNALCTL_FAIL: '1' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('cannot run');
    expect(r.stderr).toContain('insufficient permissions (simulated)');
  });

  it('journalctl absent -> cannot run (exit 2)', () => {
    const r = runLib(['journal-digest', UNIT, SINCE, '/nonexistent/journalctl-for-test']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot run');
  });
});
