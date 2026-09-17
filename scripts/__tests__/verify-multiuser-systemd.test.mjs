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
//   gate (CI=true | AC_TIER3_HOST_OK=1)  ->  rules-file preflight  ->  docker
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
// AC_TIER3_HOST_OK=1 is deliberately never set by these tests, even against
// the fake docker: it is the workstation opt-in and the delegate-side rule
// is never to set it on the dogfood host. The gate is exercised through
// CI=true (the runner's value) and through the refusal branch.

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

  it('refuses (exit 2, citing Discipline 4) when neither CI=true nor AC_TIER3_HOST_OK=1 is set, and never calls docker', () => {
    const r = runDriver(fx.root, { AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSING TO RUN');
    expect(r.stderr).toContain('Discipline 4');
    expect(r.stderr).toContain('never on the dogfood host');
    expect(dockerCalls(fx.log)).toEqual([]);
  });

  it('refuses on near-miss values (CI=false, AC_TIER3_HOST_OK=0) -- the gate compares exact values, not presence', () => {
    const r = runDriver(fx.root, { CI: 'false', AC_TIER3_HOST_OK: '0', AC_TIER3_ELEVATE: 'fake-elevate' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('REFUSING TO RUN');
    expect(dockerCalls(fx.log)).toEqual([]);
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

describe('verify-multiuser-systemd.sh: rules-file preflight (AC 3), gate open via CI=true', () => {
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
        const r = runDriver(fx.root, { CI: 'true', ...c.env });
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
      const r = runDriver(fx.root, { CI: 'true' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('docker/deployer-elevation-rules');
      expect(r.stderr).toContain('does not install');
      expect(r.stderr).toContain('AC_TIER3_ELEVATE is unset');
      expect(dockerCalls(fx.log)).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('POSITIVE CONTROL: with the gate open and the rules file, its COPY line and AC_TIER3_ELEVATE present, the driver reaches docker (the fake records the call and fails the run)', () => {
    const fx = fixtureRepo({ rulesFile: true, dockerfileInstalls: true });
    try {
      const r = runDriver(fx.root, { CI: 'true', AC_TIER3_ELEVATE: 'fake-elevate' });
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

  it('never falls back to --privileged and does not opt out of seccomp', () => {
    expect(compose).not.toMatch(/^\s*privileged:/m);
    // security_opt carries the AppArmor opt-out and nothing else (no
    // seccomp=unconfined: the comment header may mention seccomp, the
    // service block must not).
    expect(compose).toMatch(/security_opt:\s*\n\s*- apparmor=unconfined\s*\n\s*tmpfs:/);
    expect(compose).not.toMatch(/^\s*- seccomp/m);
    // one capability line only
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

  it('paths-filters on the setup / deploy scripts, their lib, both templates, docker/**, the elevation smoke and the driver', () => {
    for (const p of [
      "'docker/**'",
      "'scripts/setup-*'",
      "'scripts/update-and-deploy-*'",
      "'scripts/lib/**'",
      "'scripts/agent-console-multiuser.service.template'",
      "'scripts/*-agent-console.template'",
      "'scripts/smoke/check-embedded-agent-elevation.ts'",
      "'scripts/verify-multiuser-systemd.sh'",
    ]) {
      expect(wf).toContain(p);
    }
  });

  it('runs the driver with a 15-minute timeout, read-only token, and carries the AC_TIER3_ELEVATE env slot', () => {
    expect(wf).toContain('timeout-minutes: 15');
    expect(wf).toContain('contents: read');
    expect(wf).toContain('run: scripts/verify-multiuser-systemd.sh');
    expect(wf).toMatch(/^\s+AC_TIER3_ELEVATE:/m);
  });
});
