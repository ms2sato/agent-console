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

// Post-deploy verification V0-V6 (Issue #1717, absorbing #1688; V0 added by
// Issue #1754). Same static-source-text discipline as above: the checks
// themselves are fixture-tested in
// scripts/__tests__/setup-multiuser-checks.test.mjs (one describe per
// check), the tier-3 driver proves the shipping path on a runner
// (scripts/verify-multiuser-systemd.sh section 7 + the 7b drift arm + the
// 7c ownership-polarity arm); what THIS file pins is the sequencing this
// script owns -- which check runs on which side of the restart, when the
// journal timestamp is taken, and that the worst verification code is the
// script's exit.
describe('update-and-deploy-for-multiuser-ubuntu.sh: post-deploy verification V0-V6 sequencing (Issue #1717 / #1754)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');
  const restartIdx = scriptText.indexOf('sudo systemctl restart "${SERVICE_NAME}"');
  const idxOf = (needle) => {
    const i = scriptText.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('V0 (data-root-ownership) is called BEFORE the restart, between both readability gates and V1, and stops the script on any non-zero code (fail-closed, #1754)', () => {
    const mapGate = idxOf('assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}"');
    const v0 = idxOf('verify_check "V0 data-root-ownership" data_root_ownership "${DATA_ROOT}" "${SERVICE_USER}" find || V0_RC=$?');
    const v1 = idxOf('verify_check "V1 unit-env-drift" unit_env_drift "${UNIT_TEMPLATE}" "${SERVICE_NAME}" systemctl || V1_RC=$?');
    expect(v0).toBeGreaterThan(mapGate);
    expect(v0).toBeLessThan(v1);
    expect(v0).toBeLessThan(restartIdx);
    const abort = idxOf('exit "${V0_RC}"');
    expect(abort).toBeGreaterThan(v0);
    expect(abort).toBeLessThan(v1);
    expect(scriptText).toContain('if [ "${V0_RC}" -ne 0 ]; then');
  });

  it('V1 (unit-env-drift) is called BEFORE the restart, reading the template and the unit name, and stops the script on any non-zero code (fail-closed, #1688)', () => {
    const v1 = idxOf('verify_check "V1 unit-env-drift" unit_env_drift "${UNIT_TEMPLATE}" "${SERVICE_NAME}" systemctl || V1_RC=$?');
    expect(v1).toBeLessThan(restartIdx);
    const abort = idxOf('exit "${V1_RC}"');
    expect(abort).toBeGreaterThan(v1);
    expect(abort).toBeLessThan(restartIdx);
    expect(scriptText).toContain('if [ "${V1_RC}" -ne 0 ]; then');
    // The deploy script never renders the unit -- setup is the single writer.
    expect(scriptText).not.toMatch(/render_systemd_unit|--render-unit-only/);
    expect(scriptText).toContain('UNIT_TEMPLATE="$SCRIPT_DIR/agent-console-multiuser.service.template"');
  });

  it('V1 runs AFTER both readability gates AND V0 (the AC\'s placement: gates -> V0 -> V1 -> restart)', () => {
    const v0 = idxOf('verify_check "V0 data-root-ownership"');
    const v1 = idxOf('verify_check "V1 unit-env-drift"');
    const mapGate = idxOf('assert_readable_by_unprivileged_user "${UNIFIED_ENTRY_MAP_PATH}"');
    expect(v0).toBeGreaterThan(mapGate);
    expect(v1).toBeGreaterThan(v0);
  });

  it('the journal --since timestamp is captured IMMEDIATELY before the restart: after V1, before the restart line, nothing but comments between them', () => {
    const sinceLine = 'RESTART_SINCE="$(date \'+%Y-%m-%d %H:%M:%S\')"';
    const since = idxOf(sinceLine);
    expect(since).toBeGreaterThan(idxOf('verify_check "V1 unit-env-drift"'));
    expect(since).toBeLessThan(restartIdx);
    const between = scriptText.slice(since + sinceLine.length, restartIdx);
    expect(between.trim()).toBe('');
    // ...and the captured value is what V6 reads, not a fresh `date` after
    // the restart.
    expect(scriptText).toContain('journal_digest "${SERVICE_NAME}" "${RESTART_SINCE}" journalctl "${ELEVATE}"');
    expect(scriptText.indexOf('RESTART_SINCE=', since + 1)).toBe(-1);
  });

  it('V2-V6 are called AFTER the restart, in order, each with `|| true` so every check runs', () => {
    const calls = [
      'verify_check "V2 entry-path-readable" entry_path_readable "${UNIFIED_ENTRY_PATH}" "${UNIFIED_ENTRY_MAP_PATH}" "${ELEVATE}" || true',
      'verify_check "V3 mainpid-identity" mainpid_identity "${SERVICE_NAME}" "${CONFIGURED_BUN}" "${ELEVATE}" systemctl || true',
      'verify_check "V4 unit-active" unit_active "${SERVICE_NAME}" systemctl journalctl "${ELEVATE}" || true',
      'verify_check "V5 health" health "${PORT}" 10 curl || true',
      'verify_check "V6 journal-digest" journal_digest "${SERVICE_NAME}" "${RESTART_SINCE}" journalctl "${ELEVATE}" || true',
    ];
    let prev = restartIdx;
    for (const call of calls) {
      const i = idxOf(call);
      expect(i).toBeGreaterThan(prev);
      prev = i;
    }
  });

  it('V3\'s <configured-bun> comes from V1\'s single read (the live EMBEDDED_AGENT_BUN_PATH value), not from the template or a second systemctl call', () => {
    const extract = idxOf('CONFIGURED_BUN="$(printf \'%s\\n\' "${VERIFY_LAST_STDOUT}" | sed -n \'s/^EMBEDDED_AGENT_BUN_PATH=//p\' | head -n 1)"');
    expect(extract).toBeGreaterThan(idxOf('verify_check "V1 unit-env-drift"'));
    expect(extract).toBeLessThan(restartIdx);
  });

  it('the old /api/auth/me probe and HEALTH_URL are gone; V5 probes /api/config through the lib', () => {
    expect(scriptText).not.toContain('/api/auth/me');
    expect(scriptText).not.toContain('HEALTH_URL');
    expect(scriptText).not.toMatch(/^\s*if curl /m);
  });

  it('the worst verification code is the script\'s LAST exit, after the seven-line screen', () => {
    const lines = scriptText.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('exit "${VERIFY_EXIT}"');
    expect(lines[lines.length - 2]).toBe('echo "==> Done."');
    const screen = idxOf('verify_print_screen\nVERIFY_EXIT="$(verify_exit_code)"');
    expect(screen).toBeGreaterThan(idxOf('verify_check "V6 journal-digest"'));
    // The mapping: any FAIL -> 1; else any SKIP -> 2; else 0.
    expect(scriptText).toContain('if [ "$VERIFY_FAIL" -gt 0 ]; then\n    echo 1\n  elif [ "$VERIFY_SKIP" -gt 0 ]; then\n    echo 2\n  else\n    echo 0\n  fi');
  });

  it('the screen line shape is `  PASS  <label>` / `  FAIL  <label>: <reason>` / `  SKIP  <label>: cannot run: <reason>`', () => {
    expect(scriptText).toContain('line="  PASS  ${label}"');
    expect(scriptText).toContain('line="  FAIL  ${label}: $(head -n 1 "$err")"');
    expect(scriptText).toContain('line="  SKIP  ${label}: cannot run: $(head -n 1 "$err" | sed \'s/^cannot run: //\')"');
  });

  it('the status snapshot after the restart cannot abort the script before the screen (a non-active unit is V4\'s verdict)', () => {
    expect(scriptText).toContain('sudo systemctl status "${SERVICE_NAME}" --no-pager | head -10 || true');
  });
});
