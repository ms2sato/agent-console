import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'update-and-deploy-for-multiuser-ubuntu.sh');

// This script's fail-closed unified-entry-path gate (Issue #1668) still
// cannot be exercised end-to-end by a unit test -- a real run needs a real
// `SERVICE_USER`, a real deploy target, and a real systemd unit. The
// function it calls (assert_readable_by_unprivileged_user in
// scripts/lib/setup-multiuser-checks.sh) IS unit-tested directly, including
// its elevation seam, in scripts/__tests__/setup-multiuser-checks.test.mjs
// (Issue #1690) -- this file stays a static regression test on THIS
// script's own source text: which gate calls exist, in what order, and
// (Issue #1690) that both pass the elevation prefix. CodeRabbit review on
// the originating PR flagged that neither gate call site had any test
// coverage at all, static or otherwise, so a future accidental removal of
// either one (e.g. while refactoring the step) would pass silently.
describe('update-and-deploy-for-multiuser-ubuntu.sh: unified entry path readability gate (Issue #1668)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');

  it('gates UNIFIED_ENTRY_PATH via assert_readable_by_unprivileged_user', () => {
    expect(scriptText).toContain('assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_PATH}"');
  });

  it('gates UNIFIED_ENTRY_MAP_PATH via assert_readable_by_unprivileged_user', () => {
    expect(scriptText).toContain('assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}"');
  });

  it('runs both gates before the actual restart command, not after', () => {
    // The bare substring 'systemctl restart' also appears in this script's
    // own header comment (the numbered Steps list), well before the real
    // command -- indexOf on that alone would locate the comment, not the
    // command, and silently pass regardless of the gates' real position.
    // Anchored on the literal invocation line instead.
    const restartIdx = scriptText.indexOf('sudo systemctl restart "${SERVICE_NAME}"');
    const entryGateIdx = scriptText.indexOf(
      'assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_PATH}"',
    );
    const mapGateIdx = scriptText.indexOf(
      'assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}"',
    );
    expect(restartIdx).toBeGreaterThan(-1);
    expect(entryGateIdx).toBeGreaterThan(-1);
    expect(mapGateIdx).toBeGreaterThan(-1);
    expect(entryGateIdx).toBeLessThan(restartIdx);
    expect(mapGateIdx).toBeLessThan(restartIdx);
  });

  it('both gate calls pass the elevation prefix (Issue #1690) as their third argument', () => {
    // The probe itself needs root (via `runuser`), but this script runs as
    // the operator's own login user -- ${ELEVATE} is what lets the probe
    // elevate for that one call. A future edit that drops the third
    // argument silently reverts to #1673's original bug (bare `runuser`,
    // refused for a non-root caller).
    expect(scriptText).toContain(
      'assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_PATH}" \\\n  "step 5/6 (copy dist/embedded-agent.js to the unified entry path) did not complete, or /usr/local/lib/agent-console/ is not world-traversable -- re-run this script" \\\n  "${ELEVATE}"',
    );
    expect(scriptText).toContain(
      'assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}" \\\n  "step 5/6 (copy dist/embedded-agent.js.map to the unified entry path) did not complete, or /usr/local/lib/agent-console/ is not world-traversable -- re-run this script" \\\n  "${ELEVATE}"',
    );
  });

  it('computes ELEVATE from id -u before either gate call, empty for root and the bare interactive elevation form otherwise', () => {
    const elevateIdx = scriptText.indexOf('ELEVATE=');
    const entryGateIdx = scriptText.indexOf(
      'assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_PATH}"',
    );
    expect(elevateIdx).toBeGreaterThan(-1);
    expect(entryGateIdx).toBeGreaterThan(-1);
    expect(elevateIdx).toBeLessThan(entryGateIdx);
    expect(scriptText).toContain('if [ "$(id -u)" -ne 0 ]; then\n  ELEVATE="sudo"\nfi');
    // Not the non-interactive flag: an expired credential cache mid-deploy
    // must re-prompt, not silently fail the gate.
    expect(scriptText).not.toContain('sudo -n');
  });

  it('the Usage/Example lines no longer show the whole script invoked under elevation (the stale claim Issue #1690 removed)', () => {
    expect(scriptText).not.toMatch(/Usage:\n#\s+sudo /);
    expect(scriptText).not.toContain('sudo AGENT_CONSOLE_PORT=9000 AGENT_CONSOLE_SERVICE_USER=ac-svc');
  });
});
