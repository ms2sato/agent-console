import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'setup-multiuser-for-ubuntu.sh');

// --dry-run bypasses require_root() (see the script's require_root
// function), so this runs as any user with no system side effects -- it
// only renders the unit and prints it, never installs anything.
function renderDryRunUnit(extraArgs = []) {
  const r = spawnSync('bash', [SCRIPT, '--dry-run', ...extraArgs], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`--dry-run exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  const match = r.stdout.match(/--- Rendered unit \(start\) ---\n([\s\S]*?)\n {4}--- Rendered unit \(end\) ---/);
  if (!match) {
    throw new Error(`could not locate rendered unit block in stdout:\n${r.stdout}`);
  }
  return match[1];
}

function extractExecStartBunPath(unitText) {
  const m = unitText.match(/^ExecStart=(\S+) run start$/m);
  if (!m) throw new Error(`ExecStart line not found in:\n${unitText}`);
  return m[1];
}

function extractEmbeddedAgentBunPath(unitText) {
  const m = unitText.match(/^Environment=EMBEDDED_AGENT_BUN_PATH=(\S+)$/m);
  if (!m) throw new Error(`Environment=EMBEDDED_AGENT_BUN_PATH= line not found in:\n${unitText}`);
  return m[1];
}

// Runs --dry-run expecting a non-zero exit (validation rejection), and
// returns { status, stderr } instead of throwing -- the inverse of
// renderDryRunUnit()'s "expect success" contract above.
function runDryRunExpectingFailure(extraArgs = []) {
  const r = spawnSync('bash', [SCRIPT, '--dry-run', ...extraArgs], { encoding: 'utf-8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

// Issue #1222 -- the load-bearing in-house assertion: render_systemd_unit()
// must derive ExecStart and Environment=EMBEDDED_AGENT_BUN_PATH= from ONE
// variable, so the two rendered lines are compared to EACH OTHER here, never
// to a hardcoded literal. A literal comparison would keep passing if a
// future edit changed both lines together to something wrong; comparing
// them to each other is what locks the single-writer property (a future
// edit that desyncs the template -- e.g. reintroducing a second,
// independently-computed bun path -- makes this test fail). Verified by
// hand during development: temporarily hardcoding
// `Environment=EMBEDDED_AGENT_BUN_PATH=/some/other/path` in
// scripts/agent-console-multiuser.service.template made this assertion
// fail as expected; reverting restored the pass (see PR body for the
// pasted before/after run).
describe('setup-multiuser-for-ubuntu.sh: single-writer unified bun path (Issue #1222)', () => {
  it('renders ExecStart and Environment=EMBEDDED_AGENT_BUN_PATH= with the identical path', () => {
    const unit = renderDryRunUnit();
    const execStartPath = extractExecStartBunPath(unit);
    const embeddedAgentPath = extractEmbeddedAgentBunPath(unit);
    expect(execStartPath).toBe(embeddedAgentPath);
  });

  it('renders an absolute /usr/local/bin/bun path (the Step 6b copy destination), not the service user home', () => {
    const unit = renderDryRunUnit();
    const execStartPath = extractExecStartBunPath(unit);
    expect(execStartPath).toBe('/usr/local/bin/bun');
  });

  it('keeps the unified path stable across a --port override (unrelated parameter)', () => {
    const unit = renderDryRunUnit(['--port', '9123']);
    const execStartPath = extractExecStartBunPath(unit);
    const embeddedAgentPath = extractEmbeddedAgentBunPath(unit);
    expect(execStartPath).toBe(embeddedAgentPath);
    expect(unit).toContain('Environment=PORT=9123');
  });
});

// --public-origin validation (Issue #1312 §4.1, CodeRabbit review on
// PR #1318 -- the previous case-glob match accepted `|`/`&`/whitespace,
// which is exploitable once the value reaches the sed replacement in
// render_systemd_unit()). PUBLIC_ORIGIN_REGEX must accept an exact
// scheme://host[:port] origin and reject everything else.
describe('setup-multiuser-for-ubuntu.sh: --public-origin validation', () => {
  it('accepts an exact http(s) origin with a port and renders it verbatim', () => {
    const unit = renderDryRunUnit(['--public-origin', 'http://good.example.com:8080']);
    expect(unit).toContain('Environment=AGENT_CONSOLE_PUBLIC_ORIGIN=http://good.example.com:8080');
  });

  it('accepts an exact https origin with no port', () => {
    const unit = renderDryRunUnit(['--public-origin', 'https://good.example.com']);
    expect(unit).toContain('Environment=AGENT_CONSOLE_PUBLIC_ORIGIN=https://good.example.com');
  });

  it('rejects a trailing slash with the dedicated error message', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://good.example.com/']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('must not have a trailing slash');
  });

  it('rejects a scheme other than http/https', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'ftp://good.example.com']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects an embedded pipe character (sed delimiter injection)', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://host|d']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects an embedded ampersand / query string (sed backreference injection)', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://host?a=1&b=2']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects an embedded space', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://host name']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects a path component', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://host.com/path']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects a fragment component', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://host.com#frag']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });

  it('rejects userinfo (user:pass@)', () => {
    const { status, stderr } = runDryRunExpectingFailure(['--public-origin', 'http://user:pass@host.com']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('invalid --public-origin');
  });
});
