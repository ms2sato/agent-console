import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER = resolve(__dirname, '..', 'verify-multiuser-systemd.sh');
const COMPOSE_FILE = resolve(__dirname, '..', '..', 'docker', 'docker-compose.systemd.yml');
const WORKFLOW_FILE = resolve(__dirname, '..', '..', '.github', 'workflows', 'verify-multiuser-systemd.yml');

// Tier-1 pins for the tier-3 driver's GATE and PREFLIGHT (Issue #1706 AC 1
// and AC 3). The stack run itself is the tier-3 proof and happens only on
// an ephemeral runner (.github/workflows/verify-multiuser-systemd.yml) --
// nothing here boots a container, and nothing here may. What these tests
// establish is the ORDER the driver enforces before it touches docker:
//
//   gate (AC_TIER3_RUNNER=github-hosted | AC_TIER3_HOST_OK=1)  ->  rules-file preflight  ->  docker
//
// with a positive control proving the third arrow: when the gate is open
// and the rules file, its COPY line and AC_TIER3_ELEVATE are all present,
// the driver DOES reach docker. Without
// that control, "no docker call" in the negative cases would be
// indistinguishable from a driver that never calls docker at all.
//
// How docker is kept out: a fake `docker` executable is placed first on
// PATH. It records every invocation to a log file and exits non-zero, so
// even a driver bug that skipped the gate could not start anything -- the
// fake is the structural guarantee, the assertions read its log.
//
// How the driver is pointed at a fixture repo: it derives REPO_ROOT from its
// own location (`dirname "${BASH_SOURCE[0]}"/..`), so a SYMLINK to the real
// driver placed at <fixture>/scripts/verify-multiuser-systemd.sh makes
// <fixture> the repo root without adding any test-only seam to the script.
//
// Both accepted markers are exercised: AC_TIER3_RUNNER=github-hosted (what
// the workflow copies from GitHub's `runner.environment` context) and
// AC_TIER3_HOST_OK=1 (the workstation opt-in). The latter is set ONLY in the
// child process's environment and ONLY with the fake docker first on PATH,
// which exits 42 on every call -- no container can start, on any host, from
// these tests. The refusal branch covers a bare CI=true (any self-hosted
// runner sets it), AC_TIER3_RUNNER=self-hosted, and nothing set.

function fixtureRepo({ rulesFile, dockerfileInstalls }) {
  const root = mkdtempSync(join(tmpdir(), 'tier3-driver-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docker'));
  mkdirSync(join(root, 'bin'));
  symlinkSync(DRIVER, join(root, 'scripts', 'verify-multiuser-systemd.sh'));
  writeFileSync(
    join(root, 'docker', 'Dockerfile.systemd'),
    [
      'FROM ubuntu:24.04',
      '# a comment that names docker/deployer-elevation-rules installs nothing',
      dockerfileInstalls ? 'COPY deployer-elevation-rules /etc/elevation-rules.d/deployer' : '',
      'CMD ["/lib/systemd/systemd"]',
      '',
    ].join('\n'),
  );
  if (rulesFile) {
    writeFileSync(join(root, 'docker', 'deployer-elevation-rules'), 'deployer ALL=(ALL:ALL) NOPASSWD: ALL\n');
  }
  const log = join(root, 'fake-docker.log');
  writeFileSync(
    join(root, 'bin', 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 42\n`,
    { mode: 0o755 },
  );
  return { root, log };
}

function runDriver(root, envOverrides) {
  // Start from a scrubbed copy of the environment: the outer process may
  // itself run under CI=true (GitHub Actions), and the whole point is to
  // control the gate's inputs explicitly per test.
  const env = { ...process.env };
  delete env.CI;
  delete env.AC_TIER3_RUNNER;
  delete env.AC_TIER3_HOST_OK;
  delete env.AC_TIER3_ELEVATE;
  env.PATH = `${join(root, 'bin')}:${env.PATH ?? '/usr/bin:/bin'}`;
  Object.assign(env, envOverrides);
  // Spawned via its own shebang (no `bash` argv, no `-c`): the same
  // CodeQL-safe shape setup-multiuser-checks.test.mjs uses.
  return spawnSync(join(root, 'scripts', 'verify-multiuser-systemd.sh'), [], { encoding: 'utf-8', env });
}

function dockerCalls(log) {
  return existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : [];
}

describe('verify-multiuser-systemd.sh: never-on-the-dogfood-host gate (AC 1)', () => {
  let fx;
  beforeEach(() => { fx = fixtureRepo({ rulesFile: true, dockerfileInstalls: true }); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  it('refuses (exit 2, citing Discipline 4) when neither AC_TIER3_RUNNER=github-hosted nor AC_TIER3_HOST_OK=1 is set, and never calls docker', () => {
    const r = runDriver(fx.root, { AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSING TO RUN');
    expect(r.stderr).toContain('Discipline 4');
    expect(r.stderr).toContain('never on the dogfood host');
    expect(dockerCalls(fx.log)).toEqual([]);
  });

  it('refuses on near-miss values (AC_TIER3_RUNNER=self-hosted, AC_TIER3_HOST_OK=0) -- the gate compares exact values, not presence', () => {
    const r = runDriver(fx.root, { AC_TIER3_RUNNER: 'self-hosted', AC_TIER3_HOST_OK: '0', AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSING TO RUN');
    expect(dockerCalls(fx.log)).toEqual([]);
  });

  it('refuses a bare CI=true (any CI system or self-hosted runner sets it) -- only the GitHub-evaluated marker or the workstation opt-in opens the gate', () => {
    const r = runDriver(fx.root, { CI: 'true', AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSING TO RUN');
    expect(r.stderr).toContain('CI=true alone is');
    expect(dockerCalls(fx.log)).toEqual([]);
  });

  it('names the markers it saw and the ones it accepts in the refusal', () => {
    const r = runDriver(fx.root, { AC_TIER3_RUNNER: 'self-hosted', AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("seen: AC_TIER3_RUNNER='self-hosted' AC_TIER3_HOST_OK=''");
    expect(r.stderr).toContain('accepted markers: AC_TIER3_RUNNER=github-hosted or AC_TIER3_HOST_OK=1');
    expect(dockerCalls(fx.log)).toEqual([]);
  });

  it('opens on AC_TIER3_HOST_OK=1 alone (the workstation opt-in) -- proven by the fake docker being reached', () => {
    const r = runDriver(fx.root, { AC_TIER3_HOST_OK: '1', AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.stderr).not.toContain('REFUSING TO RUN');
    expect(r.stderr).not.toMatch(/error: missing/);
    expect(dockerCalls(fx.log).length).toBeGreaterThan(0);
    expect(r.status).not.toBe(0);
  });

  it('the refusal is decided BEFORE the rules-file preflight (a refused run names no missing file)', () => {
    const missing = fixtureRepo({ rulesFile: false, dockerfileInstalls: false });
    try {
      const r = runDriver(missing.root, {});
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('REFUSING TO RUN');
      expect(r.stderr).not.toMatch(/error: missing/);
      expect(dockerCalls(missing.log)).toEqual([]);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
  });
});

describe('verify-multiuser-systemd.sh: rules-file preflight (AC 3), gate open via AC_TIER3_RUNNER=github-hosted', () => {
  const cases = [
    {
      name: 'the operator rules file docker/deployer-elevation-rules is absent',
      fixture: { rulesFile: false, dockerfileInstalls: true },
      env: { AC_TIER3_ELEVATE: 'fake-elevate' },
      names: ['docker/deployer-elevation-rules'],
      notNamed: ['does not install', 'AC_TIER3_ELEVATE is unset'],
    },
    {
      name: 'docker/Dockerfile.systemd has no COPY line installing it (a comment naming the file does not count)',
      fixture: { rulesFile: true, dockerfileInstalls: false },
      env: { AC_TIER3_ELEVATE: 'fake-elevate' },
      names: ['docker/Dockerfile.systemd does not install docker/deployer-elevation-rules'],
      notNamed: ['AC_TIER3_ELEVATE is unset'],
    },
    {
      name: 'AC_TIER3_ELEVATE is unset',
      fixture: { rulesFile: true, dockerfileInstalls: true },
      env: {},
      names: ['AC_TIER3_ELEVATE is unset', '.github/workflows/verify-multiuser-systemd.yml'],
      notNamed: ['does not install'],
    },
    {
      name: 'AC_TIER3_ELEVATE is set but empty (the workflow placeholder value)',
      fixture: { rulesFile: true, dockerfileInstalls: true },
      env: { AC_TIER3_ELEVATE: '' },
      names: ['AC_TIER3_ELEVATE is unset'],
      notNamed: ['does not install'],
    },
  ];

  for (const c of cases) {
    it(`exits 2 naming the missing item and never calls docker when ${c.name}`, () => {
      const fx = fixtureRepo(c.fixture);
      try {
        const r = runDriver(fx.root, { AC_TIER3_RUNNER: 'github-hosted', ...c.env });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/error: missing/);
        for (const s of c.names) expect(r.stderr).toContain(s);
        for (const s of c.notNamed) expect(r.stderr).not.toContain(s);
        expect(r.stderr).not.toContain('REFUSING TO RUN');
        expect(dockerCalls(fx.log)).toEqual([]);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }

  it('reports every missing line at once (all three absent -> all three named, one exit)', () => {
    const fx = fixtureRepo({ rulesFile: false, dockerfileInstalls: false });
    try {
      const r = runDriver(fx.root, { AC_TIER3_RUNNER: 'github-hosted' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('docker/deployer-elevation-rules');
      expect(r.stderr).toContain('does not install');
      expect(r.stderr).toContain('AC_TIER3_ELEVATE is unset');
      expect(dockerCalls(fx.log)).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('POSITIVE CONTROL: with the gate open (AC_TIER3_RUNNER=github-hosted) and the rules file, its COPY line and AC_TIER3_ELEVATE present, the driver reaches docker (the fake records the call and fails the run)', () => {
    const fx = fixtureRepo({ rulesFile: true, dockerfileInstalls: true });
    try {
      const r = runDriver(fx.root, { AC_TIER3_RUNNER: 'github-hosted', AC_TIER3_ELEVATE: 'fake-elevate' });
      // The fake docker exits 42 on every call, so the run cannot succeed;
      // what matters is WHY it stopped: past the gate, past the preflight,
      // at a docker call.
      expect(r.stderr).not.toContain('REFUSING TO RUN');
      expect(r.stderr).not.toMatch(/error: missing/);
      const calls = dockerCalls(fx.log);
      expect(calls.length).toBeGreaterThan(0);
      // The first thing the driver asks docker is the host facts it records
      // for the log (docker info's security options + cgroup version, AC 2),
      // and the build goes through compose against the systemd compose file.
      expect(calls.some((c) => c.startsWith('info '))).toBe(true);
      expect(calls.some((c) => c.includes('compose -f') && c.includes('docker-compose.systemd.yml'))).toBe(true);
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe('docker/docker-compose.systemd.yml: the measured tier-3 boot set, not --privileged (Issue #1706 constraint)', () => {
  const compose = readFileSync(COMPOSE_FILE, 'utf-8');

  it('adds CAP_SYS_ADMIN only, host cgroupns, a rw cgroup bind, tmpfs /run + /run/lock, container=docker, apparmor=unconfined, a tty', () => {
    expect(compose).toMatch(/cap_add:\s*\n\s*- SYS_ADMIN\s*\n/);
    expect(compose).toContain('cgroup: host');
    expect(compose).toContain('- /sys/fs/cgroup:/sys/fs/cgroup:rw');
    expect(compose).toMatch(/tmpfs:\s*\n\s*- \/run\s*\n\s*- \/run\/lock/);
    expect(compose).toContain('container: docker');
    expect(compose).toContain('- apparmor=unconfined');
    expect(compose).toContain('tty: true');
    expect(compose).toContain('stop_signal: SIGRTMIN+3');
  });

  it('never falls back to --privileged, adds no capability beyond SYS_ADMIN, and does not opt out of seccomp', () => {
    expect(compose).not.toMatch(/^\s*privileged:/m);
    // security_opt carries the AppArmor opt-out and nothing else (no
    // seccomp=unconfined: the comment header may mention seccomp, the
    // service block must not).
    expect(compose).toMatch(/security_opt:\s*\n\s*- apparmor=unconfined\s*\n\s*tmpfs:/);
    expect(compose).not.toMatch(/^\s*- seccomp/m);
    // one capability ADDED (cap_add keeps Docker's defaults; no cap_drop)
    expect(compose.match(/^\s*- [A-Z_]+\s*$/gm)).toEqual(['      - SYS_ADMIN']);
  });

  it('publishes no host port (every probe runs inside the container)', () => {
    expect(compose).not.toMatch(/^\s*ports:/m);
  });
});

describe('.github/workflows/verify-multiuser-systemd.yml: triggers per AC 6 and the 15-minute budget', () => {
  const wf = readFileSync(WORKFLOW_FILE, 'utf-8');

  it('has push (main + the landing branch), pull_request and workflow_dispatch triggers', () => {
    expect(wf).toMatch(/^on:\s*\n\s+push:/m);
    expect(wf).toContain('- main');
    expect(wf).toContain('- feat/1706-tier3-systemd-verification-stack');
    expect(wf).toMatch(/^\s+pull_request:/m);
    expect(wf).toMatch(/^\s+workflow_dispatch:/m);
  });

  it('paths-filters on the setup / deploy scripts, their lib, both templates, docker/**, the elevation smoke, the driver, and root package.json (Issue #1776)', () => {
    for (const p of [
      "'docker/**'",
      "'scripts/setup-*'",
      "'scripts/update-and-deploy-*'",
      "'scripts/lib/**'",
      "'scripts/agent-console-multiuser.service.template'",
      "'scripts/*-agent-console.template'",
      "'scripts/smoke/check-embedded-agent-elevation.ts'",
      "'scripts/verify-multiuser-systemd.sh'",
      "'package.json'",
    ]) {
      expect(wf).toContain(p);
    }
  });

  it('the package.json path entry appears in BOTH the push and pull_request paths lists, not just one', () => {
    const occurrences = wf.split("'package.json'").length - 1;
    expect(occurrences).toBe(2);
  });

  it('runs the driver with a 15-minute timeout, read-only token, and carries the AC_TIER3_ELEVATE env slot', () => {
    expect(wf).toContain('timeout-minutes: 15');
    expect(wf).toContain('contents: read');
    expect(wf).toContain('run: scripts/verify-multiuser-systemd.sh');
    expect(wf).toMatch(/^\s+AC_TIER3_ELEVATE:/m);
  });

  it('copies GitHub\'s runner.environment context into AC_TIER3_RUNNER (the gate marker; a bare CI=true is not the gate)', () => {
    expect(wf).toContain('AC_TIER3_RUNNER: ${{ runner.environment }}');
    expect(wf).not.toMatch(/^\s+CI:/m);
  });
});

// Issue #1717: section 7 consumes the deploy script's own V0-V6 screen (V0
// added by Issue #1754) and the 7b drift arm (#1688) is present and
// ordered. Static source-text pins on the driver, same discipline as the
// deploy-script pins in update-and-deploy-for-multiuser-ubuntu.test.mjs: the
// arm itself runs only on a runner (nothing here boots a container).
describe('verify-multiuser-systemd.sh: section 7 consumes the V0-V6 screen; the 7b drift arm and the 7c ownership-polarity arm are present and ordered (Issue #1717 / #1688 / #1754)', () => {
  const driver = readFileSync(DRIVER, 'utf-8');
  const idxOf = (needle) => {
    const i = driver.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('main runs the sections in order: run_deploy -> post_deploy_checks -> drift_arm -> ownership_polarity_arm -> restart_survival_arm -> path_first_bun_arm -> helper_cases -> run_smokes', () => {
    expect(driver).toContain(
      '  run_deploy\n  post_deploy_checks\n  drift_arm\n  ownership_polarity_arm\n  restart_survival_arm\n  path_first_bun_arm\n  helper_cases\n  run_smokes\n',
    );
    expect(driver).toMatch(/^drift_arm\(\) \{/m);
    expect(driver).toMatch(/^ownership_polarity_arm\(\) \{/m);
    expect(driver).toMatch(/^restart_survival_arm\(\) \{/m);
    expect(driver).toMatch(/^path_first_bun_arm\(\) \{/m);
    // Placed after section 7 in the file too (the AC's "new section, after 7"),
    // 7c after 7b, 7d after 7c, and 7e (#1776) after 7d.
    expect(idxOf('drift_arm() {')).toBeGreaterThan(idxOf('post_deploy_checks() {'));
    expect(idxOf('ownership_polarity_arm() {')).toBeGreaterThan(idxOf('drift_arm() {'));
    expect(idxOf('restart_survival_arm() {')).toBeGreaterThan(idxOf('ownership_polarity_arm() {'));
    expect(idxOf('path_first_bun_arm() {')).toBeGreaterThan(idxOf('restart_survival_arm() {'));
    expect(idxOf('path_first_bun_arm() {')).toBeLessThan(idxOf('helper_cases() {'));
  });

  it('section 7 asserts the seven PASS lines by label (V0 first) plus the RESULT line, via one shared helper, instead of re-implementing the checks', () => {
    for (const label of ['V0 data-root-ownership', 'V1 unit-env-drift', 'V2 entry-path-readable', 'V3 mainpid-identity', 'V4 unit-active', 'V5 health', 'V6 journal-digest']) {
      expect(driver).toContain(`  "${label}"`);
    }
    // V0 is first in V_LABELS.
    expect(driver).toMatch(/V_LABELS=\(\s*\n\s*"V0 data-root-ownership"/);
    expect(driver).toContain('grep -q "^  PASS  ${label}\\$" "$out" || rc=$?');
    expect(driver).toContain("grep -q '^  RESULT: 7 PASS, 0 FAIL, 0 SKIP -> exit 0$' \"$out\" || rc=$?");
    expect(driver).toContain('assert_seven_pass "$DEPLOY_OUT" "deploy #1"');
    expect(driver).not.toContain('assert_six_pass');
    // Scoped to the shared V0-V6 mechanism (before any arm), not the whole
    // file: 7e (#1776) legitimately asserts a literal "RESULT: 6 PASS, 1
    // FAIL, 0 SKIP -> exit 1" for its own polarity deploy (V6 fails on
    // purpose there), so a whole-file ban would forbid a correct assertion
    // rather than catch a re-implementation of the shared helper.
    expect(driver.slice(0, idxOf('drift_arm() {'))).not.toMatch(/RESULT: 6 PASS/);
    // The old per-check re-implementation and the old /api/auth/me probe
    // assertion are gone.
    expect(driver).not.toContain('/api/auth/me');
    expect(driver).not.toContain('expect "systemctl is-active ${UNIT} = active"');
    expect(driver).not.toContain('expect "MainPID executes the unified bun');
    expect(driver).not.toContain('NOT HERE: the #1688 drift arm');
  });

  it('the drift arm removes ONE template key from the live unit file with sed + daemon-reload and records why a drop-in cannot do it', () => {
    const arm = driver.slice(idxOf('drift_arm() {'), idxOf('ownership_polarity_arm() {'));
    expect(arm).toContain("sed -i '/^Environment=EMBEDDED_AGENT_ENTRY_PATH=/d' '${unit_file}' && systemctl daemon-reload");
    // The rationale is recorded in the function's own comment (wrapped across
    // two lines, hence two needles).
    expect(arm).toContain('drop-in cannot unset one key visibly to `systemctl show -p Environment`');
    expect(arm).toContain('`UnsetEnvironment=` is applied at exec time');
    expect(arm).toContain("absent from 'systemctl show -p Environment' after sed + daemon-reload");
  });

  it('the drift arm asserts deploy #2 exits 1 on V1 naming the key, with V0 unaffected and NO restart (no restart line, ActiveEnterTimestampMonotonic unchanged, no V2-V6 line)', () => {
    const arm = driver.slice(idxOf('drift_arm() {'), idxOf('ownership_polarity_arm() {'));
    const order = [
      'ts_before="$(cexec --user root "$SERVICE" systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT"',
      'expect "drift: deploy #2 exits 1 (V1 FAIL, the worst code)" test "$rc" -eq 1',
      "grep -q '^  PASS  V0 data-root-ownership$' \"$out\"",
      "grep -q '^  FAIL  V1 unit-env-drift: .*EMBEDDED_AGENT_ENTRY_PATH' \"$out\"",
      "grep -q 'setup-multiuser-for-ubuntu.sh --dry-run' \"$out\"",
      "grep -q 'service.d/\\*.conf drop-in' \"$out\"",
      "check \"drift: no '==> systemctl restart' line -- the deploy stopped before the restart\" \"$restarted\"",
      'check "drift: no V2-V6 line -- nothing after V1 ran" "$v_after_v1"',
      'expect "drift: ActiveEnterTimestampMonotonic unchanged (${ts_before}) -- the unit was NOT restarted" test "$ts_after" = "$ts_before"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = arm.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('the drift arm then runs setup --force (same flags as 4b), asserts the key is back, and asserts deploy #3 exits 0 with the seven PASS lines and a real restart', () => {
    const arm = driver.slice(idxOf('drift_arm() {'), idxOf('ownership_polarity_arm() {'));
    const order = [
      'bash scripts/setup-multiuser-for-ubuntu.sh --force --repo-source /src --add-user alice --add-user deployer',
      'check "drift: setup --force exits 0" "$rc"',
      "present again in 'systemctl show -p Environment' (the unit was re-rendered)",
      'check "drift: deploy #3 exits 0" "$rc"',
      'assert_seven_pass "$out" "drift: deploy #3"',
      'test "$ts_after" != "$ts_before"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = arm.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
    // The flags match section 4b's setup --force exactly (one source of the
    // container's unit parameters).
    const setupForce = 'bash scripts/setup-multiuser-for-ubuntu.sh --force --repo-source /src --add-user alice --add-user deployer';
    expect(driver.indexOf(setupForce)).toBeLessThan(idxOf('drift_arm() {'));
    expect(arm).toContain(setupForce);
  });

  it('every deploy invocation in the driver runs as `deployer` (never root), so the screen is the operator-path screen', () => {
    // Deploy #3 (Issue #1761, F2) carries an extra `-e AGENT_CONSOLE_PORT=9999`
    // between `-w "$SRC"` and `"$SERVICE"` -- the one deliberately-wrong
    // override that distinguishes "the live unit wins" from the pre-#1761
    // behaviour; the regex tolerates that one optional segment.
    const deployCalls = driver.match(/cexec --user \S+ -w "\$SRC" (?:-e AGENT_CONSOLE_PORT=9999 )?"\$SERVICE" bash scripts\/update-and-deploy-for-multiuser-ubuntu\.sh/g) ?? [];
    // deploy #1 (run_deploy) + #2/#3 (drift_arm) + #4/#5/#5b/#5c (ownership_polarity_arm) + #6 (restart_survival_arm) + #7/#8 (path_first_bun_arm, #1776).
    expect(deployCalls).toHaveLength(10);
    for (const c of deployCalls) expect(c).toContain('--user deployer ');
  });

  it('deploy #3 exports AGENT_CONSOLE_PORT=9999 for that one invocation and asserts the live unit wins (PORT (V5): 8080 source=unit) with the WARN naming 9999', () => {
    const arm = driver.slice(idxOf('drift_arm() {'), idxOf('ownership_polarity_arm() {'));
    expect(arm).toContain(
      'cexec --user deployer -w "$SRC" -e AGENT_CONSOLE_PORT=9999 "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh >"$out" 2>&1 || rc=$?',
    );
    expect(arm).toContain("PORT (V5): 8080 (source: unit)'");
    expect(arm).toContain("WARN: AGENT_CONSOLE_PORT=9999 differs from the live unit's PORT=8080");
  });
});

// The 7c ownership-polarity arm (#1754), pinned the way 7b is pinned above.
describe('verify-multiuser-systemd.sh: 7c ownership-polarity arm is present and ordered (Issue #1754)', () => {
  const driver = readFileSync(DRIVER, 'utf-8');
  const idxOf = (needle) => {
    const i = driver.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  const arm = () => driver.slice(idxOf('ownership_polarity_arm() {'), idxOf('restart_survival_arm() {'));

  it('synthesizes repositories/<org>/<repo>/worktrees, re-owns it to the service user, and proves a positive control (OWNERSHIP_OK) via a direct helper probe before any injection', () => {
    const a = arm();
    expect(a).toContain('install -d -m 2775 -o agentconsole -g agent-console-users');
    expect(a).toContain('chown -R agentconsole:agent-console-users "$org_dir"');
    expect(a).toContain('bash "$HELPER" data-root-ownership "$DATA_ROOT" agentconsole find');
    expect(a).toContain('control_marker="$(head -n 1 "$probe_out" | tr -d \'\\r\')"');
    const order = [
      'chown -R agentconsole:agent-console-users "$org_dir"',
      'bash "$HELPER" data-root-ownership "$DATA_ROOT" agentconsole find >"$probe_out" 2>"$probe_err"',
      'expect "7c: positive control -- a clean synthesized tree PASSes V0 (OWNERSHIP_OK) before any injection"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('both #1754 marker probes capture stdout and stderr into SEPARATE files, never merged (Issue #1766)', () => {
    const a = arm();
    const splitCapture = 'find >"$probe_out" 2>"$probe_err"';
    const mergedCapture = 'find >"$probe_out" 2>&1';
    const splitCount = (a.match(new RegExp(splitCapture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(splitCount).toBe(2);
    expect(a).not.toContain(mergedCapture);
  });

  it('creates the non-walked control (templates dir, chown deployer) BEFORE injecting the org-dir misownership, and the injection is non-recursive', () => {
    const a = arm();
    const order = [
      'chown deployer "$templates_dir"',
      'chown deployer "$org_dir"',
      'echo "  --- deploy #4',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
    // Non-recursive: the injection (`chown deployer "$org_dir"`, no `-R`)
    // and the restore (`chown agentconsole:agent-console-users "$org_dir"`,
    // no `-R`) both target the org dir alone; only the initial setup step
    // above them uses `-R`.
    expect(a).not.toMatch(/chown -R deployer/);
    expect(a).toContain('chown agentconsole:agent-console-users "$org_dir"');
  });

  it('deploy #4 asserts V0 FAIL naming the org dir, the chown remedy, no restart, and no V1-V6 line (fail-closed, before restart)', () => {
    const a = arm();
    const order = [
      'expect "7c: deploy #4 exits 1 (V0 FAIL, the worst code)" test "$rc" -eq 1',
      'expect "7c: V0 FAIL line names ${org_dir}"',
      'expect "7c: the chown remedy line names ${org_dir}"',
      'check "7c: no \'==> systemctl restart\' line -- the deploy stopped before the restart" "$restarted"',
      'check "7c: no V1-V6 line -- nothing after V0 ran" "$v_after_v0"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('deploy #5 asserts the seven PASS lines, the templates-dir INFO line, an OWNERSHIP_OK marker probe (never NO_TREES), and the control staying mis-owned', () => {
    const a = arm();
    expect(a).toContain('assert_seven_pass "$out" "7c: deploy #5"');
    const order = [
      'assert_seven_pass "$out" "7c: deploy #5"',
      'expect "7c: V0\'s INFO line names the non-walked control as ignored"',
      'expect "7c: post-#5 marker is OWNERSHIP_OK, not OWNERSHIP_NO_TREES (the tree stays)"',
      'expect "7c: the non-walked control is still owned by deployer (nobody auto-fixed it)"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  // The one-segment repo base (Issue #1760's name-aware classification):
  // solo_dir carries its own non-walked control and its own polarity
  // injection, extending the 7c arm rather than replacing anything above.
  it('creates the one-segment repo base (solo_dir, with an outputs child) and its own non-walked control (solo_daily_dir) in the same setup step as the org tree and templates_dir', () => {
    const a = arm();
    expect(a).toContain('local solo_dir="${DATA_ROOT}/repositories/solo"');
    expect(a).toContain('local solo_daily_dir="${solo_dir}/daily"');
    expect(a).toContain('"$solo_dir" "${solo_dir}/outputs"');
    expect(a).toContain('chown -R agentconsole:agent-console-users "$solo_dir"');
    const order = [
      'chown deployer "$templates_dir"',
      'chown deployer "$solo_daily_dir"',
      'chown deployer "$org_dir"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('deploy #5 additionally asserts the solo_daily_dir INFO line', () => {
    const a = arm();
    const order = [
      'assert_seven_pass "$out" "7c: deploy #5"',
      'expect "7c: V0\'s INFO line names the one-segment-base non-walked control as ignored"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('deploy #5b: a second polarity injection misowns solo_dir alone (non-recursive) and asserts V0 FAIL naming it, the chown remedy, and no restart', () => {
    const a = arm();
    const order = [
      'expect "7c: the non-walked control is still owned by deployer (nobody auto-fixed it)"',
      'chown deployer "$solo_dir"',
      'expect "7c: deploy #5b exits 1 (V0 FAIL, the worst code)" test "$rc" -eq 1',
      'expect "7c: V0 FAIL line names ${solo_dir}"',
      'expect "7c: the chown remedy line names ${solo_dir}"',
      'check "7c: no \'==> systemctl restart\' line on deploy #5b -- the deploy stopped before the restart" "$restarted_5b"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('deploy #5c: restores solo_dir ownership and asserts exit 0 with the seven PASS lines, leaving the arm in a green state', () => {
    const a = arm();
    const order = [
      'expect "7c: the chown remedy line names ${solo_dir}"',
      'chown agentconsole:agent-console-users "$solo_dir"',
      'check "7c: deploy #5c exits 0" "$rc"',
      'assert_seven_pass "$out" "7c: deploy #5c"',
      'step_end ownership_polarity',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });
});

// A marker read by `head -n 1` must come from a stdout-only capture; the
// exec transport (`docker compose exec -T`, wrapped by `cexec`) does not
// preserve cross-stream write order, so a file opened with `2>&1` can put an
// INFO/WARN stderr line ahead of the marker on line 1 (Issue #1766). This
// sweeps the WHOLE driver, not just the 7c arm, for any `head -n 1 "$V"` read
// of a variable V that was ever captured via `>"$V" 2>&1`.
//
// Reach measured: temporarily restoring `2>&1` on one of the two #1754 probe
// lines (reverting one of this PR's two split-capture edits) makes this
// test's negative assertion fail, confirming the pin actually looks at the
// read site rather than passing vacuously. That measurement is recorded in
// the PR body rather than committed here, per workflow.md's "a check's
// existence is not its detection power".
describe('verify-multiuser-systemd.sh: no `head -n 1` reads a merged-stream capture file (Issue #1766)', () => {
  const driver = readFileSync(DRIVER, 'utf-8');

  it('every variable captured via `2>&1` is never the target of a `head -n 1` read, and the sweep is proven non-vacuous', () => {
    const mergedCaptureVars = new Set();
    const mergedCaptureRe = /> *"\$(\w+)" 2>&1/g;
    let m;
    while ((m = mergedCaptureRe.exec(driver)) !== null) {
      mergedCaptureVars.add(m[1]);
    }

    // Positive control: the driver still has ordinary `>"$out" 2>&1`
    // captures elsewhere (grep-consumed, never read by `head -n 1`), so this
    // sweep is exercising a non-empty set rather than vacuously passing on
    // an instrument that finds nothing.
    expect(mergedCaptureVars.size).toBeGreaterThan(0);

    for (const v of mergedCaptureVars) {
      const headReadRe = new RegExp(`head -n 1 "\\$${v}"`);
      expect(driver).not.toMatch(headReadRe);
    }

    // Confirms the pin is looking at the real read site: `probe_out` (this
    // PR's split-capture target) is still read by `head -n 1` -- just never
    // via a merged `2>&1` capture, since it is now captured with `2>"$probe_err"`.
    expect(driver).toContain('head -n 1 "$probe_out"');
  });
});

// The 7d restart-survival arm (#1762), pinned the way 7b/7c are pinned above.
describe('verify-multiuser-systemd.sh: 7d restart-survival arm is present and ordered (Issue #1762)', () => {
  const driver = readFileSync(DRIVER, 'utf-8');
  const idxOf = (needle) => {
    const i = driver.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  const arm = () => driver.slice(idxOf('restart_survival_arm() {'), idxOf('path_first_bun_arm() {'));

  it('seeds the session and its two FK dependents via bun -e + bun:sqlite against the real data.db, as agentconsole, before the restart', () => {
    const a = arm();
    expect(a).toContain('import { Database } from "bun:sqlite";');
    expect(a).toContain('new Database("/var/lib/agent-console/data.db")');
    expect(a).toContain('PRAGMA busy_timeout = 5000');
    expect(a).toContain('PRAGMA foreign_keys = ON');
    expect(a).toContain('INSERT INTO repositories');
    expect(a).toContain('INSERT INTO sessions');
    expect(a).toContain('INSERT INTO repository_orchestrator_sessions');
    expect(a).toContain('INSERT INTO inbound_event_notifications');
    expect(a).toContain('cexec --user agentconsole "$SERVICE" bun -e "$seed_js"');
    const order = [
      'seed_js=\'import { Database }',
      'cexec --user agentconsole "$SERVICE" bun -e "$seed_js"',
      'expect "7d: seed script exits 0 and prints SEEDED"',
      'echo "  --- deploy #6',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('seeds a `quick` session at DATA_ROOT with NULL data_scope/data_scope_slug, so initializeSessions() takes the path-exists branch, not the orphan branch', () => {
    const a = arm();
    expect(a).toContain('"quick", "/var/lib/agent-console", null');
  });

  it('runs deploy #6 (the shipping restart path) as deployer, asserting exit 0 and the seven PASS lines, same as #1/#2/#3/#4/#5', () => {
    const a = arm();
    expect(a).toContain('cexec --user deployer -w "$SRC" "$SERVICE" bash scripts/update-and-deploy-for-multiuser-ubuntu.sh');
    expect(a).toContain('check "7d: deploy #6 exits 0" "$rc"');
    expect(a).toContain('assert_seven_pass "$out" "7d: deploy #6"');
  });

  it('reads the seeded rows back after the restart, asserting the session is present BEFORE the dependent-row assertions (positive control against the orphan path)', () => {
    const a = arm();
    const order = [
      'cexec --user agentconsole "$SERVICE" bun -e "$read_js"',
      'expect "7d: the seeded session is still present after the restart (not classified as an orphan)"',
      'expect "7d: session created_at is unchanged',
      'expect "7d: session updated_at moved past the seed value',
      'expect "7d: repository_orchestrator_sessions designation still exists (DESIGNATION_COUNT=1)"',
      'expect "7d: inbound_event_notifications row still exists with status=pending"',
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });
});

// The 7e PATH-first-bun arm (#1776), pinned the way 7b/7c/7d are pinned
// above. Ordering after 7d and before helper_cases is asserted in the
// "main runs the sections in order" test above; this describe block covers
// the arm's own content.
describe('verify-multiuser-systemd.sh: 7e PATH-first-bun arm is present and ordered (Issue #1776)', () => {
  const driver = readFileSync(DRIVER, 'utf-8');
  const idxOf = (needle) => {
    const i = driver.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  // The two SED_TO_* script constants are declared at the TOP LEVEL of the
  // file, immediately above `path_first_bun_arm() {` -- outside `arm()`'s
  // slice, which starts at the function itself -- so they are checked
  // against the whole `driver` text, not `arm()`.
  const armStart = () => idxOf('path_first_bun_arm() {');
  const arm = () => driver.slice(armStart(), idxOf('helper_cases() {'));

  it('plants a SECOND bun inode at the exact path the unit\'s Environment=PATH puts first, distinct from the unified bun', () => {
    const a = arm();
    expect(a).toContain('local service_bun="/home/agentconsole/.bun/bin/bun"');
    expect(a).toContain('install -D -m 0755 "$UNIFIED_BUN" "$service_bun"');
    expect(a).toContain('the planted service-user bun is a SEPARATE inode from the unified bun');
  });

  it('injects the pre-fix (af8fed78) bare-`bun` start line via a sed script delivered over stdin, never interpolated into a `sh -c` string', () => {
    expect(driver).toContain(
      'SED_TO_PRE_FIX_START=\'s|^\\([[:space:]]*\\)"start":.*|\\1"start": "NODE_ENV=production bun dist/index.js",|\'',
    );
    // Declared before the arm, consumed inside it.
    expect(idxOf('SED_TO_PRE_FIX_START=')).toBeLessThan(armStart());
    expect(arm()).toContain('printf \'%s\\n\' "$SED_TO_PRE_FIX_START" | cexec --user agentconsole -w "$SRC" "$SERVICE" sed -i -f - -- "$pkg"');
  });

  it('restores the exact fixed `$npm_execpath` form via its own sed script, distinct from the pre-fix one', () => {
    expect(driver).toContain(
      'SED_TO_FIXED_START=\'s|^\\([[:space:]]*\\)"start":.*|\\1"start": "NODE_ENV=production \\\\"$npm_execpath\\\\" dist/index.js",|\'',
    );
    expect(idxOf('SED_TO_FIXED_START=')).toBeLessThan(armStart());
    const a = arm();
    expect(a).toContain('printf \'%s\\n\' "$SED_TO_FIXED_START" | cexec --user agentconsole -w "$SRC" "$SERVICE" sed -i -f - -- "$pkg"');
    // Byte-exact restore check reads for the literal escaped form, not a loose match.
    expect(a).toContain('grep -qF \'"start": "NODE_ENV=production \\"$npm_execpath\\" dist/index.js",\'');
  });

  it('deploy #7 (polarity): expects V0-V5 PASS, V6 FAIL naming the EMBEDDED_AGENT_BUN_PATH warning, exit 1, and the restart still happens (Done. is printed)', () => {
    const a = arm();
    expect(a).toContain('check "7e polarity: deploy #7 exits 1 (V6 FAIL, the worst code)" "$rc"');
    // The six V0-V5 labels are iterated via a shell `for label in ...` loop,
    // not spelled out individually -- assert the loop's own label list, and
    // the templated assertion line that consumes `${label}`.
    expect(a).toContain(
      'for label in "V0 data-root-ownership" "V1 unit-env-drift" "V2 entry-path-readable" "V3 mainpid-identity" "V4 unit-active" "V5 health"; do',
    );
    expect(a).toContain(`expect "7e polarity: deploy #7 screen has '  PASS  \${label}'" grep -q "^  PASS  \${label}\\$" "$out"`);
    expect(a).toContain(
      "expect \"7e polarity: deploy #7's V6 FAILs naming the EMBEDDED_AGENT_BUN_PATH warning\"",
    );
    expect(a).toContain("grep -q '^  FAIL  V6 journal-digest: the server logged an EMBEDDED_AGENT_BUN_PATH warning at boot'");
    expect(a).toContain("grep -qF '  RESULT: 6 PASS, 1 FAIL, 0 SKIP -> exit 1'");
    expect(a).toContain("grep -qF '==> Done.'");
    const order = [
      "echo \"  --- deploy #7",
      'check "7e polarity: deploy #7 exits 1 (V6 FAIL, the worst code)" "$rc"',
      'for label in "V0 data-root-ownership"',
      "expect \"7e polarity: deploy #7's V6 FAILs naming the EMBEDDED_AGENT_BUN_PATH warning\"",
      "expect \"7e polarity: deploy #7's RESULT is 6 PASS, 1 FAIL, 0 SKIP -> exit 1\"",
      "expect \"7e polarity: deploy #7 still printed Done.",
    ];
    let prev = -1;
    for (const needle of order) {
      const i = a.indexOf(needle);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('reads the dist/index.js child\'s own exe (MainPID\'s child, not MainPID itself) via pgrep -P, asserting it against the service-user bun under polarity and the unified bun once fixed', () => {
    const a = arm();
    expect(a).toContain('pgrep -P "$mainpid"');
    expect(a).toContain('cexec --user agentconsole:agent-console-users "$SERVICE" readlink -f "/proc/${child_pid:-0}/exe"');
    expect(a).toContain(
      'expect "7e polarity: the dist/index.js child executed the PATH-first service-user bun (${service_bun})" \\\n    test "$child_exe" = "$service_bun"',
    );
    expect(a).toContain(
      'expect "7e fixed: the dist/index.js child executed the unified bun (${UNIFIED_BUN}), regardless of the service-user bun ahead on PATH" \\\n    test "$child_exe" = "$UNIFIED_BUN"',
    );
  });

  it('re-runs setup --force between the two deploys, asserting step 6b now takes its COPY branch (the service-user bun exists) instead of its skip-warning branch', () => {
    const a = arm();
    expect(a).toContain('bash scripts/setup-multiuser-for-ubuntu.sh --force --repo-source /src --add-user alice --add-user deployer');
    expect(a).toContain("install -m 0755 ${service_bun} ${UNIFIED_BUN}");
    expect(a).toContain("step 6b did NOT print its skip-warning line this time");
  });

  it('deploy #8 (fixed tree): expects the seven PASS lines via the shared assert_seven_pass helper -- V3\'s PASS line IS "V3 prints SAME" on this screen', () => {
    const a = arm();
    expect(a).toContain('check "7e fixed: deploy #8 exits 0" "$rc"');
    expect(a).toContain('assert_seven_pass "$out" "7e fixed: deploy #8"');
    expect(a).toContain("V3's only PASS outcome is a SAME marker");
  });

  it('the driver\'s top-of-file notes are updated: V3\'s DIFFERENT-arm note explains why 7e\'s second inode does not make V3 go DIFFERENT, and step 6b\'s NOT-EXERCISED notes point at 7e', () => {
    expect(driver).toContain('7e (below) is the first arm');
    expect(driver).toContain('so V3 stays SAME through');
    expect(driver).toContain('NOT EXERCISED (yet -- see 7e below): setup step 6b');
    expect(driver).toContain('NOW EXERCISED (7e, #1776): setup step 6b');
  });
});
