import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../check-restart-all-embedded.js';

/**
 * Pure-function tests for `check-restart-all-embedded.ts`. Never runs
 * `main()`'s billable path -- no `AppContext`, no real `claude` CLI, no
 * billed turn. This is the Q13 "proxy verification" discipline
 * `test-trigger.md` documents for every billable smoke in that file: it
 * verifies the WIRING (argument parsing, and that `--help` is free) is
 * correct, without the billable chain it sits upstream of.
 */

describe('check-restart-all-embedded smoke: parseArgs', () => {
  it('defaults both flags to false with no flags', () => {
    expect(parseArgs([])).toEqual({ help: false, expectNotRestarted: false });
  });

  it('sets help on --help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true, expectNotRestarted: false });
  });

  it('sets help on -h', () => {
    expect(parseArgs(['-h'])).toEqual({ help: true, expectNotRestarted: false });
  });

  it('sets expectNotRestarted on --expect-not-restarted', () => {
    expect(parseArgs(['--expect-not-restarted'])).toEqual({ help: false, expectNotRestarted: true });
  });

  it('tolerates a leading -- separator', () => {
    expect(parseArgs(['--', '--expect-not-restarted'])).toEqual({ help: false, expectNotRestarted: true });
  });

  it('throws with the usage text for an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Usage:/);
    expect(() => parseArgs(['--bogus'])).toThrow(/--expect-not-restarted/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag: --bogus/);
  });
});

describe('check-restart-all-embedded smoke: --help is free (real subprocess)', () => {
  it('exits 0 within ~2s, prints usage, and creates no scratch AGENT_CONSOLE_HOME-shaped directory', () => {
    const tmp = os.tmpdir();
    const before = new Set(
      fs.readdirSync(tmp).filter((name) => name.startsWith('ac-restart-all-smoke-cfg-')),
    );

    const scriptPath = path.join(import.meta.dir, '../check-restart-all-embedded.ts');
    const start = Date.now();
    const proc = Bun.spawnSync([process.execPath, scriptPath, '--help'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const elapsedMs = Date.now() - start;

    expect(proc.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
    const stdout = proc.stdout.toString();
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--expect-not-restarted');

    const after = new Set(
      fs.readdirSync(tmp).filter((name) => name.startsWith('ac-restart-all-smoke-cfg-')),
    );
    const newEntries = [...after].filter((name) => !before.has(name));
    expect(newEntries).toEqual([]);
  });
});
