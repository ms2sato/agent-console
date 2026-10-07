import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import { parseArgs } from '../check-shared-account-binding.js';

/**
 * `scripts/smoke/check-shared-account-binding.ts` has one pure, exported
 * function (`parseArgs`) -- everything else runs inline at `main()` time
 * against a real disposable `AppContext` and real elevation, so it can only
 * be exercised by actually running the script, not by importing and
 * unit-testing a function (same shape as `check-embedded-agent-elevation.ts`'s
 * own sibling test).
 *
 * `parseArgs` is pure on the success paths (no `process.exit`), so those are
 * imported and asserted directly; the usage-error paths call
 * `process.exit(2)` before any env mutation or spawn, so they are exercised
 * as a real subprocess, mirroring `check-embedded-agent-elevation.test.ts`'s
 * `--auth-mode` usage-error table.
 */
describe('check-shared-account-binding smoke: argv parsing', () => {
  it('parses two positionals with expectGlobalAccount defaulting to false', () => {
    expect(parseArgs(['alice', 'bob'])).toEqual({
      accountAUsername: 'alice',
      accountBUsername: 'bob',
      expectGlobalAccount: false,
    });
  });

  it('accepts --expect-global-account in any position', () => {
    expect(parseArgs(['alice', 'bob', '--expect-global-account'])).toEqual({
      accountAUsername: 'alice',
      accountBUsername: 'bob',
      expectGlobalAccount: true,
    });
    expect(parseArgs(['--expect-global-account', 'alice', 'bob'])).toEqual({
      accountAUsername: 'alice',
      accountBUsername: 'bob',
      expectGlobalAccount: true,
    });
    expect(parseArgs(['alice', '--expect-global-account', 'bob'])).toEqual({
      accountAUsername: 'alice',
      accountBUsername: 'bob',
      expectGlobalAccount: true,
    });
  });

  it('tolerates a leading -- separator (the `bun script -- --flag` form the sibling smokes accept)', () => {
    expect(parseArgs(['--', 'alice', 'bob', '--expect-global-account'])).toEqual({
      accountAUsername: 'alice',
      accountBUsername: 'bob',
      expectGlobalAccount: true,
    });
  });

  it.each([
    [[], 'missing <account-A-username> and/or <account-B-username>'],
    [['alice'], 'missing <account-A-username> and/or <account-B-username>'],
    [['alice', 'bob', 'carol'], 'unexpected extra argument(s): carol'],
    [['alice', 'bob', '--bogus'], 'unknown flag: --bogus'],
  ])('exits 2 with a usage error for argv %j (before any spawn or env mutation)', (argv, expectedError) => {
    const scriptPath = path.join(import.meta.dir, '../check-shared-account-binding.ts');
    const proc = Bun.spawnSync([process.execPath, scriptPath, ...argv], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(2);
    const stderrText = proc.stderr.toString();
    expect(stderrText).toContain(`error: ${expectedError}`);
    expect(stderrText).toContain(
      'usage: bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username> [--expect-global-account]',
    );
    expect(stderrText).not.toContain('PROBE ERROR');
  });
});
