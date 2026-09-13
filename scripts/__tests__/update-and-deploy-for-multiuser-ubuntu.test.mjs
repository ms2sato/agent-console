import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'update-and-deploy-for-multiuser-ubuntu.sh');

// This script's fail-closed unified-entry-path gate (Issue #1668) cannot be
// exercised by a unit test -- it runs as root and probes via `runuser`,
// neither of which is available or safe in an unprivileged CI process (see
// assert_readable_by_unprivileged_user's own doc comment in
// scripts/lib/setup-multiuser-checks.sh: "do not fake it"). This is
// therefore a static regression test on the script's own source text, not a
// behavioral one -- CodeRabbit review on this PR flagged that neither gate
// call site had any test coverage at all, static or otherwise, so a future
// accidental removal of either one (e.g. while refactoring the step) would
// pass silently.
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
});
