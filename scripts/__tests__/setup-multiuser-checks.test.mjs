import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(__dirname, '..', 'lib', 'setup-multiuser-checks.sh');

// assert_unified_bun_executable is a pure, side-effect-free function split
// out of scripts/setup-multiuser-for-ubuntu.sh (Issue #1222 Ruling 2) so its
// fail-closed contract can be tested directly, without root and without
// running the full bootstrap script (which requires real root privilege for
// any non-dry-run path). The production script sources this same file, so
// there is no replication to drift.
function runAssert(path) {
  const script = `
    set -eu
    source "${LIB}"
    assert_unified_bun_executable "${path}"
  `;
  return spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
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
    const script = `
      set -eu
      source "${LIB}"
      tmp="$(mktemp)"
      chmod 0644 "$tmp"
      trap 'rm -f "$tmp"' EXIT
      assert_unified_bun_executable "$tmp"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing or not executable');
  });

  it('succeeds (exit 0, no stderr) when the path exists and is executable', () => {
    const r = runAssert('/bin/true');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
