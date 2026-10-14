import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
    // Each entry is the call's stable PREFIX (the check and its leading
    // arguments); V5 and V6 later gained trailing arguments (the poll window, the
    // unit and systemctl), so the pin is order + the trailing `|| true`, not the
    // exact tail. Their tails are pinned in the dedicated block below.
    const calls = [
      'verify_check "V2 entry-path-readable" entry_path_readable "${UNIFIED_ENTRY_PATH}" "${UNIFIED_ENTRY_MAP_PATH}" "${ELEVATE}"',
      'verify_check "V3 mainpid-identity" mainpid_identity "${SERVICE_NAME}" "${CONFIGURED_BUN}" "${ELEVATE}" systemctl',
      'verify_check "V4 unit-active" unit_active "${SERVICE_NAME}" systemctl journalctl "${ELEVATE}"',
      'verify_check "V5 health" health "${HEALTH_PORT}"',
      'verify_check "V6 journal-digest" journal_digest "${SERVICE_NAME}" "${RESTART_SINCE}" journalctl "${ELEVATE}"',
    ];
    let prev = restartIdx;
    for (const call of calls) {
      const i = idxOf(call);
      expect(i).toBeGreaterThan(prev);
      const lineEnd = scriptText.indexOf('\n', i);
      expect(scriptText.slice(i, lineEnd).endsWith(' || true')).toBe(true);
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

// V5's port resolution (Issue #1761): the live unit's own PORT= (read at V1,
// the same single read that already feeds V3's CONFIGURED_BUN) must win over
// a guessed AGENT_CONSOLE_PORT default. Same static-source-text discipline
// as above: resolve_health_port itself is fixture-tested directly in
// scripts/__tests__/setup-multiuser-checks.test.mjs; what THIS file pins is
// that the deploy script actually wires LIVE_PORT through it and feeds V5
// from the result, not from the raw env-var default.
describe('update-and-deploy-for-multiuser-ubuntu.sh: V5 port resolution wiring (Issue #1761)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');

  it('LIVE_PORT is derived from VERIFY_LAST_STDOUT after V1 and before the restart', () => {
    const v1 = scriptText.indexOf('verify_check "V1 unit-env-drift"');
    const restartIdx = scriptText.indexOf('sudo systemctl restart "${SERVICE_NAME}"');
    const livePortIdx = scriptText.indexOf(
      'LIVE_PORT="$(printf \'%s\\n\' "${VERIFY_LAST_STDOUT}" | sed -n \'s/^PORT=//p\' | head -n 1)"',
    );
    expect(v1).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(livePortIdx).toBeGreaterThan(-1);
    expect(livePortIdx).toBeGreaterThan(v1);
    expect(livePortIdx).toBeLessThan(restartIdx);
  });

  it('resolve_health_port is called with LIVE_PORT and PORT_OVERRIDE, with the literal "8080" as the third (default) argument', () => {
    expect(scriptText).toContain(
      'RESOLVE_PORT_OUT="$(resolve_health_port "${LIVE_PORT}" "${PORT_OVERRIDE}" "8080" 2>"${RESOLVE_PORT_ERR}")"',
    );
  });

  // PORT_OVERRIDE must be the RAW env var, empty when AGENT_CONSOLE_PORT was
  // not exported -- NOT "${AGENT_CONSOLE_PORT:-8080}". The defect this pins
  // against: if the override argument defaulted to 8080 here, it would never
  // be empty, so (a) resolve_health_port's "default" source would be
  // unreachable from this script, and (b) on any host whose live unit's
  // PORT differs from 8080 (e.g. 6340), the script would print a spurious
  // "WARN: AGENT_CONSOLE_PORT=8080 differs from the live unit's PORT=6340"
  // even though the operator never exported AGENT_CONSOLE_PORT at all.
  it('PORT_OVERRIDE is the raw env var with no baked-in default (the literal "8080" default lives only in the call site\'s third argument)', () => {
    expect(scriptText).toContain('PORT_OVERRIDE="${AGENT_CONSOLE_PORT:-}"');
    expect(scriptText).not.toContain('PORT_OVERRIDE="${AGENT_CONSOLE_PORT:-8080}"');
    expect(scriptText).not.toContain('PORT_FALLBACK');
  });

  it('V5\'s argument is ${HEALTH_PORT}, and the old `health "${PORT}"` shape is gone', () => {
    // Prefix only: the trailing arguments (poll window, unit, systemctl) are
    // pinned in the V5/V6 window block below; what THIS pin protects is that the
    // port argument is the resolved ${HEALTH_PORT}.
    expect(scriptText).toMatch(/^verify_check "V5 health" health "\$\{HEALTH_PORT\}" .* \|\| true$/m);
    expect(scriptText).not.toContain('health "${PORT}"');
  });

  it('the "PORT (V5):" annotation line exists, right after the resolution and before the restart', () => {
    const line = 'echo "        PORT (V5): ${HEALTH_PORT} (source: ${HEALTH_PORT_SOURCE})"';
    const i = scriptText.indexOf(line);
    const restartIdx = scriptText.indexOf('sudo systemctl restart "${SERVICE_NAME}"');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(restartIdx);
  });

  it('there is exactly one systemctl show read path for the port -- the deploy script itself never calls systemctl show for PORT directly', () => {
    // The only "systemctl show" reads in this script are V1's own (via
    // unit_env_drift, inside the lib) -- this script's own text contains no
    // second, independent `systemctl show ... PORT` read.
    expect(scriptText).not.toMatch(/systemctl show[^\n]*PORT/);
  });
});

// The post-deploy window (#2043): the deploy script hands V5 and V6 their
// waiting windows. The library's own defaults (10 polls, 1 journal read) would
// bring the false FAIL on a slow boot straight back, with every library test
// still green, so the call sites are pinned HERE -- the one test file for this
// script's shape (the library behaviour is tested in setup-multiuser-checks.test.mjs).
describe('update-and-deploy-for-multiuser-ubuntu.sh: V5/V6 windows (#2043)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');

  it('V5 passes the validated poll count, then curl, the unit and systemctl (so a dead unit fails fast)', () => {
    expect(scriptText).toContain(
      'verify_check "V5 health" health "${HEALTH_PORT}" "${HEALTH_ATTEMPTS}" curl "${SERVICE_NAME}" systemctl || true',
    );
  });

  it('the poll count comes from AGENT_CONSOLE_HEALTH_ATTEMPTS through normalize_attempts with the 60 default, never raw', () => {
    expect(scriptText).toContain('HEALTH_ATTEMPTS="$(normalize_attempts "${AGENT_CONSOLE_HEALTH_ATTEMPTS:-}" 60)"');
    expect(scriptText).not.toContain('"${AGENT_CONSOLE_HEALTH_ATTEMPTS:-60}"');
    // ...and it is computed before the restart, so a bad value warns up front.
    expect(scriptText.indexOf('HEALTH_ATTEMPTS="$(normalize_attempts')).toBeLessThan(
      scriptText.indexOf('sudo systemctl restart "${SERVICE_NAME}"'),
    );
  });

  it('V6 passes 10 re-read attempts after the elevate argument', () => {
    expect(scriptText).toContain(
      'verify_check "V6 journal-digest" journal_digest "${SERVICE_NAME}" "${RESTART_SINCE}" journalctl "${ELEVATE}" 10 || true',
    );
  });

  it('the header documents AGENT_CONSOLE_HEALTH_ATTEMPTS beside AGENT_CONSOLE_PORT', () => {
    const header = scriptText.split('\n').slice(0, 130).join('\n');
    expect(header).toContain('AGENT_CONSOLE_HEALTH_ATTEMPTS');
    expect(header.indexOf('AGENT_CONSOLE_PORT')).toBeLessThan(header.indexOf('AGENT_CONSOLE_HEALTH_ATTEMPTS'));
  });
});

// Pinned-SHA build (Issue #2090, phase 1 of #919; docs/design/deploy-build-flow.md
// section 6): the deploy archives ONE resolved commit into a per-deploy build
// directory and builds/copies from there. Two layers, as above: static pins on
// this script's text for the ordering that cannot be run unelevated, and a
// behavioural run of the real script file with a stand-in `sudo` first on PATH
// (it drops `-u <user> [--]` and execs the rest, and REFUSES every root-level
// invocation, so nothing real can be elevated or installed).
describe('update-and-deploy-for-multiuser-ubuntu.sh: pinned-SHA build via git archive (Issue #2090) -- static pins', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');
  const idxOf = (needle) => {
    const i = scriptText.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };
  const DEPLOY_SHA_LINE =
    'DEPLOY_SHA="${AGENT_CONSOLE_DEPLOY_SHA:-$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse origin/main)}"';
  const GUARD = 'cat-file -e "${DEPLOY_SHA}^{commit}"';
  const ARCHIVE_LINE =
    "sudo -u \"${SERVICE_USER}\" bash -c 'set -o pipefail; git -C \"$1\" archive \"$2\" | tar -x -C \"$3\"' _ \"${SRC}\" \"${DEPLOY_SHA}\" \"${BUILD_DIR}\"";

  it('resolves DEPLOY_SHA once from AGENT_CONSOLE_DEPLOY_SHA, defaulting to origin/main of the source repo', () => {
    expect(scriptText.split(DEPLOY_SHA_LINE).length - 1).toBe(1);
  });

  it('the cat-file commit guard comes before the build directory is created, with the documented error and exit 1', () => {
    expect(idxOf(GUARD)).toBeLessThan(idxOf('mktemp -d "${DATA_ROOT}/build.XXXXXX"'));
    expect(scriptText).toContain(
      'echo "Error: AGENT_CONSOLE_DEPLOY_SHA/origin/main does not resolve to a commit in ${SRC}" >&2\n  exit 1',
    );
  });

  it('DEPLOY_SHA is normalized to the full commit SHA after the guard and before the build directory and the printed line', () => {
    const norm = idxOf('DEPLOY_SHA="$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse "${DEPLOY_SHA}^{commit}")"');
    expect(norm).toBeGreaterThan(idxOf(GUARD));
    expect(norm).toBeLessThan(idxOf('echo "    DEPLOY_SHA: ${DEPLOY_SHA}"'));
    expect(norm).toBeLessThan(idxOf('mktemp -d "${DATA_ROOT}/build.XXXXXX"'));
  });

  it('the pre-check prints DEPLOY_SHA and its subject, not HEAD', () => {
    expect(scriptText).toContain('echo "    DEPLOY_SHA: ${DEPLOY_SHA}"');
    expect(scriptText).toContain('git -C "${SRC}" log --oneline -1 "${DEPLOY_SHA}"');
  });

  it('the archive step runs as the service user with `set -o pipefail` INSIDE the shell that owns the pipe', () => {
    expect(scriptText).toContain(ARCHIVE_LINE);
    // bash, not dash: Ubuntu 22.04's dash has no pipefail.
    expect(scriptText).not.toMatch(/(?<![a-z])sh -c 'set -o pipefail/);
  });

  it('the EXIT trap is registered after the build dir exists and before the archive line', () => {
    const mk = idxOf('BUILD_DIR="$(sudo -u "${SERVICE_USER}" mktemp -d');
    const trap = idxOf('trap remove_build_dir EXIT');
    expect(trap).toBeGreaterThan(mk);
    expect(trap).toBeLessThan(idxOf(ARCHIVE_LINE));
  });

  it('installs with --frozen-lockfile, builds, and rsyncs from BUILD_DIR (never from SRC)', () => {
    const install = idxOf('cd -- "$1" && bun install --frozen-lockfile\n\' _ "${BUILD_DIR}"');
    const build = idxOf('cd -- "$1" && NODE_ENV=production bun run build\n\' _ "${BUILD_DIR}"');
    const rsync = idxOf('"${BUILD_DIR}/" "${DST}/"');
    expect(idxOf(ARCHIVE_LINE)).toBeLessThan(install);
    expect(install).toBeLessThan(build);
    expect(build).toBeLessThan(rsync);
    expect(scriptText).not.toContain('"${SRC}/" "${DST}/"');
    expect(scriptText).not.toMatch(/^\s*cd -- "\$1" && bun install\n/m);
  });

  it('the build dir is removed explicitly after the rsync and BEFORE the V0 call, and the removal clears its own state', () => {
    const rsync = idxOf('"${BUILD_DIR}/" "${DST}/"');
    const call = idxOf('\nremove_build_dir\n');
    const v0 = idxOf('verify_check "V0 data-root-ownership"');
    expect(call).toBeGreaterThan(rsync);
    expect(call).toBeLessThan(v0);
    // Cleared state is what keeps the EXIT trap from running a second removal.
    expect(scriptText).toContain('    BUILD_DIR=""\n  fi\n}');
  });

  it('the marker printf receives DEPLOY_SHA', () => {
    expect(scriptText).toContain('"$3/.deploy-sha"\' _ "${DEPLOY_SHA}" "${DEPLOYED_AT}" "${DST}"');
  });

  it('both HEAD re-checks are gone, and HEAD is never read as the deployed revision', () => {
    expect(scriptText).not.toContain('source HEAD changed during build');
    expect(scriptText).not.toContain('source HEAD changed during deploy');
    expect(scriptText).not.toContain('rev-parse HEAD');
    expect(scriptText).not.toContain('DEPLOYED_SHA');
  });

  it('the header documents AGENT_CONSOLE_DEPLOY_SHA with its origin/main default', () => {
    const header = scriptText.split('\n').slice(0, 130).join('\n');
    // The env-var table row (the Steps list also names the variable, so a
    // bare substring would be satisfied without the table row).
    expect(header).toMatch(/^#   AGENT_CONSOLE_DEPLOY_SHA {5,}\S/m);
    expect(header).toMatch(/Default: origin\/main of the source repo/);
  });
});

// Behavioural: the production archive pipeline text, extracted from the script
// and run with a producer that dies AFTER emitting a complete, valid tar. GNU
// tar exits 0 on that stream, so only the inner `set -o pipefail` makes the
// step fail; the variant with it stripped is the polarity control.
describe('update-and-deploy-for-multiuser-ubuntu.sh: the archive pipeline fails when `git archive` fails (Issue #2090)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8');
  const m = scriptText.match(/bash -c '(set -o pipefail; git -C "\$1" archive "\$2" \| tar -x -C "\$3")' _ "\$\{SRC\}"/);

  function runPipeline(inner, producerFails) {
    const root = mkdtempSync(join(tmpdir(), 'archive-pipe-'));
    const bin = join(root, 'bin');
    const payload = join(root, 'payload');
    const out = join(root, 'out');
    mkdirSync(bin);
    mkdirSync(payload);
    mkdirSync(out);
    writeFileSync(join(payload, 'a.txt'), 'a\n');
    // A stand-in `git` whose `archive` emits a complete tar, then exits as told.
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/bash\ntar -c -f - -C "${payload}" a.txt\nexit ${producerFails ? 1 : 0}\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const r = spawnSync('bash', ['-c', inner, '_', 'unused-src', 'unused-sha', out], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return { status: r.status, extracted: existsSync(join(out, 'a.txt')) };
  }

  it('the pipeline text was found in the script', () => {
    expect(m).not.toBeNull();
  });

  it('exits 0 when git archive succeeds (positive control: the harness extracts)', () => {
    const r = runPipeline(m[1], false);
    expect(r).toEqual({ status: 0, extracted: true });
  });

  it('exits non-zero when git archive fails after a valid stream', () => {
    expect(runPipeline(m[1], true).status).not.toBe(0);
  });

  it('polarity control: the same pipeline WITHOUT pipefail masks the failure with tar\'s 0', () => {
    const stripped = m[1].replace('set -o pipefail; ', '');
    expect(stripped).not.toBe(m[1]);
    expect(runPipeline(stripped, true).status).toBe(0);
  });
});

// Behavioural: the real script file, past the SHA guard and through the
// rsync, against a scratch repository. `sudo` is a stand-in on PATH that logs
// every call, drops `-u <user> [--]` and execs the rest, short-circuits the two
// bun steps (install/build: no network, no toolchain), and exits 99 on any
// root-level call -- the script's step 5 (`sudo install ...` into /usr/local)
// -- so nothing outside the temp tree can be written.
describe('update-and-deploy-for-multiuser-ubuntu.sh: pinned-SHA flow run against a scratch repository (Issue #2090)', () => {
  function makeHarness() {
    const root = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
    const dataRoot = join(root, 'data');
    const src = join(dataRoot, 'source-repos', 'agent-console');
    const dst = join(root, 'deploy-target');
    const bin = join(root, 'bin');
    const log = join(root, 'fake-sudo.log');
    mkdirSync(src, { recursive: true });
    mkdirSync(dst);
    mkdirSync(bin);
    // Hermetic git, inline: this file is plain Node (.mjs) and cannot import
    // scratch-git.ts (the single writer of this pattern for TS callers).
    const gitCfg = join(root, 'gitconfig');
    writeFileSync(gitCfg, '[commit]\n\tgpgsign = false\n[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n');
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('GIT_') || k.startsWith('AGENT_CONSOLE_')) continue;
      baseEnv[k] = v;
    }
    baseEnv.GIT_CONFIG_GLOBAL = gitCfg;
    baseEnv.GIT_CONFIG_NOSYSTEM = '1';
    const git = (...args) => {
      const r = spawnSync('git', ['-C', src, ...args], { env: baseEnv, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    git('init', '-q');
    writeFileSync(join(src, 'tracked.txt'), 'tracked\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const firstSha = git('rev-parse', 'HEAD');
    // origin/main is the FIRST commit; HEAD moves on, so a HEAD read is distinguishable.
    git('update-ref', 'refs/remotes/origin/main', firstSha);
    writeFileSync(join(src, 'later.txt'), 'later\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second');
    const headSha = git('rev-parse', 'HEAD');
    writeFileSync(join(src, 'dirty.txt'), 'untracked working-tree file\n');

    writeFileSync(
      join(bin, 'sudo'),
      [
        '#!/bin/bash',
        'echo "sudo $*" >> "$FAKE_SUDO_LOG"',
        'if [ "$1" != "-u" ]; then',
        '  echo "ROOT-LEVEL: $*" >> "$FAKE_SUDO_LOG"',
        '  for d in "$AGENT_CONSOLE_DATA_ROOT"/build.*; do [ -e "$d" ] && echo "BUILD_DIR_PRESENT: $d" >> "$FAKE_SUDO_LOG"; done',
        '  exit 99',
        'fi',
        'shift 2',
        '[ "${1:-}" = "--" ] && shift',
        'if [ "${1:-}" = "bash" ] && [ "${2:-}" = "-lc" ] && [[ "${3:-}" == *bun* ]]; then',
        '  echo "BUN-STEP: $(ls -A "$5" | tr "\\n" " ")" >> "$FAKE_SUDO_LOG"',
        '  [ -n "${FAKE_BUN_FAIL:-}" ] && exit 77',
        '  exit 0',
        'fi',
        'exec "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'sudo'), 0o755);

    const run = (extraEnv = {}) => {
      const r = spawnSync('bash', [SCRIPT], {
        env: {
          ...baseEnv,
          PATH: `${bin}:${process.env.PATH}`,
          AGENT_CONSOLE_DATA_ROOT: dataRoot,
          AGENT_CONSOLE_DEPLOY_TARGET_DIR: dst,
          AGENT_CONSOLE_SERVICE_USER: 'svc',
          FAKE_SUDO_LOG: log,
          ...extraEnv,
        },
        encoding: 'utf8',
        timeout: 60000,
      });
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        log: existsSync(log) ? readFileSync(log, 'utf8') : '',
        buildDirs: readdirSync(dataRoot).filter((n) => n.startsWith('build.')),
      };
    };
    return { run, src, dst, firstSha, headSha };
  }

  const GUARD_ERROR = 'Error: AGENT_CONSOLE_DEPLOY_SHA/origin/main does not resolve to a commit in ';

  it('an unknown override SHA exits 1 with the guard error before any build directory or install step', () => {
    const h = makeHarness();
    const r = h.run({ AGENT_CONSOLE_DEPLOY_SHA: '0'.repeat(40) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${GUARD_ERROR}${h.src}`);
    expect(r.log).not.toContain('mktemp');
    expect(r.log).not.toContain('BUN-STEP');
    expect(r.buildDirs).toEqual([]);
    expect(readdirSync(h.dst)).toEqual([]);
  });

  it('with no override and no resolvable origin/main it ends in the same error, not a silent set -e exit', () => {
    const h = makeHarness();
    spawnSync('git', ['-C', h.src, 'update-ref', '-d', 'refs/remotes/origin/main'], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const r = h.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${GUARD_ERROR}${h.src}`);
    expect(r.log).not.toContain('mktemp');
    expect(r.buildDirs).toEqual([]);
  });

  it('an install failure leaves no build directory behind (the EXIT trap) and the archive held the committed tree only', () => {
    const h = makeHarness();
    const r = h.run({ AGENT_CONSOLE_DEPLOY_SHA: h.headSha, FAKE_BUN_FAIL: '1' });
    expect(r.status).toBe(77);
    const bunStep = r.log.split('\n').find((l) => l.startsWith('BUN-STEP:')) ?? '';
    expect(bunStep).toContain('tracked.txt');
    expect(bunStep).toContain('later.txt');
    expect(bunStep).not.toContain('dirty.txt');
    expect(r.buildDirs).toEqual([]);
    expect(readdirSync(h.dst)).toEqual([]);
  });

  it('the default is origin/main (not HEAD): that tree is copied, the marker records it, and the build dir is already gone before step 5', () => {
    const h = makeHarness();
    const r = h.run();
    // Stops at step 5's root-level `sudo install`, by design of the stand-in.
    expect(r.status).toBe(99);
    expect(r.stdout).toContain(`DEPLOY_SHA: ${h.firstSha}`);
    expect(r.log).toContain('ROOT-LEVEL: install');
    expect(r.log).not.toContain('BUILD_DIR_PRESENT');
    expect(readdirSync(h.dst).sort()).toEqual(['.deploy-sha', 'tracked.txt']);
    expect(readFileSync(join(h.dst, '.deploy-sha'), 'utf8').split('\n')[0]).toBe(h.firstSha);
    expect(r.buildDirs).toEqual([]);
  });

  it('a branch name or short SHA override is recorded as the full 40-char SHA', () => {
    const h = makeHarness();
    for (const override of ['main', h.firstSha.slice(0, 8)]) {
      const r = h.run({ AGENT_CONSOLE_DEPLOY_SHA: override });
      expect(r.status).toBe(99);
      const line1 = readFileSync(join(h.dst, '.deploy-sha'), 'utf8').split('\n')[0];
      expect(line1).toMatch(/^[0-9a-f]{40}$/);
      expect(line1).toBe(override === 'main' ? h.headSha : h.firstSha);
      expect(r.stdout).toContain(`DEPLOY_SHA: ${line1}`);
    }
  });

  it('an explicit override wins over origin/main', () => {
    const h = makeHarness();
    const r = h.run({ AGENT_CONSOLE_DEPLOY_SHA: h.headSha });
    expect(r.status).toBe(99);
    expect(readFileSync(join(h.dst, '.deploy-sha'), 'utf8').split('\n')[0]).toBe(h.headSha);
    expect(existsSync(join(h.dst, 'later.txt'))).toBe(true);
  });
});
