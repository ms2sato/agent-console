import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

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
