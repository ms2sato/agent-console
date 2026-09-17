import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import { parseArgs } from '../check-embedded-agent-elevation.js';

/**
 * `scripts/smoke/check-embedded-agent-elevation.ts` has no exported functions
 * (all logic runs inline at module-evaluation / `main()` time), so its
 * probe-cannot-run guards can only be exercised by actually running the
 * script as a real subprocess, not by importing and unit-testing a function.
 *
 * This test reproduces the real Issue #1221 failure mode reported from a real
 * multi-user host: under `sudo`, the elevated child's PATH is `sudo`'s own
 * `secure_path`, which does not include a user-local `~/.bun/bin` -- so the
 * default (unset `EMBEDDED_AGENT_BUN_PATH`, bare-name `'bun'`) branch's
 * `Bun.spawnSync(['bun', '--version'])` throws synchronously ("Executable not
 * found in $PATH") instead of returning a result. The guard must catch that
 * and exit 2 (probe-cannot-run), not let it propagate to the generic
 * catch-all in `main()` (which would report a false assertion FAILURE, exit 1).
 */
describe('check-embedded-agent-elevation smoke: bun-path probe-cannot-run guard', () => {
  it("exits 2 (probe-cannot-run), not 1 (failure), when default 'bun' is unresolvable via PATH", () => {
    const scriptPath = path.join(import.meta.dir, '../check-embedded-agent-elevation.ts');
    const bunExecutable = process.execPath;

    const proc = Bun.spawnSync([bunExecutable, scriptPath, 'some-target-user'], {
      env: {
        // A minimal, real-world "secure_path"-shaped PATH with no bun on it,
        // and EMBEDDED_AGENT_BUN_PATH deliberately unset -- reproduces the
        // real host failure without needing a real elevated sudo invocation.
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(2);
    const stderrText = proc.stderr.toString();
    expect(stderrText).toContain('Could not execute');
    expect(stderrText).not.toContain('PROBE ERROR');
  });
});

/**
 * `--auth-mode` (Issue #1738) selects both the value written to
 * `AGENT_CONSOLE_MCP_AUTH` and the assertion set applied to the tokenless
 * `/mcp` call (E1). The default MUST be `enforce`: the resolver's own default
 * is `warn` for every AUTH_MODE since Issue #1107, so a smoke that fell
 * through to it would run its "enforce" assertions against a warn-mode gate
 * -- exactly the stale premise #1738 exists to close. `parseArgs` is pure
 * on the success paths (no process.exit), so it is imported directly; the
 * usage-error paths call `process.exit(2)` and are exercised as a real
 * subprocess below, like the bun-path guard test above.
 */
describe('check-embedded-agent-elevation smoke: --auth-mode flag parsing', () => {
  it('defaults to enforce with only <target-user> given', () => {
    expect(parseArgs(['alice'])).toEqual({ targetUsername: 'alice', authMode: 'enforce' });
  });

  it('accepts --auth-mode warn (space form) and --auth-mode=warn (equals form), in either position', () => {
    expect(parseArgs(['alice', '--auth-mode', 'warn'])).toEqual({ targetUsername: 'alice', authMode: 'warn' });
    expect(parseArgs(['alice', '--auth-mode=warn'])).toEqual({ targetUsername: 'alice', authMode: 'warn' });
    expect(parseArgs(['--auth-mode', 'warn', 'alice'])).toEqual({ targetUsername: 'alice', authMode: 'warn' });
    expect(parseArgs(['alice', '--auth-mode', 'enforce'])).toEqual({ targetUsername: 'alice', authMode: 'enforce' });
  });

  it('tolerates a leading -- separator (the `bun script -- --flag` form the sibling smokes accept)', () => {
    expect(parseArgs(['--', 'alice', '--auth-mode', 'warn'])).toEqual({ targetUsername: 'alice', authMode: 'warn' });
  });

  it.each([
    [[], 'missing <target-user>'],
    [['alice', '--auth-mode', 'off'], 'invalid --auth-mode value: off'],
    [['alice', '--auth-mode'], 'invalid --auth-mode value: undefined'],
    [['alice', '--bogus'], 'unknown flag: --bogus'],
    [['alice', 'bob'], 'unexpected extra argument: bob'],
  ])('exits 2 with a usage error for argv %j (before any spawn or env mutation)', (argv, expectedError) => {
    const scriptPath = path.join(import.meta.dir, '../check-embedded-agent-elevation.ts');
    const proc = Bun.spawnSync([process.execPath, scriptPath, ...argv], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(2);
    const stderrText = proc.stderr.toString();
    expect(stderrText).toContain(`error: ${expectedError}`);
    expect(stderrText).toContain('usage: bun scripts/smoke/check-embedded-agent-elevation.ts <target-user> [--auth-mode enforce|warn]');
    expect(stderrText).not.toContain('PROBE ERROR');
  });
});
