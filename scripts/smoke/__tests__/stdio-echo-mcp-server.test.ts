/**
 * Sibling test for `scripts/smoke/fixtures/stdio-echo-mcp-server.ts`'s
 * OPT-IN `--spawn-report <path>` option (Issue #1799). Spawns the real
 * fixture as a subprocess (never a hand-replicated copy) with and without
 * the flag, and asserts:
 *
 *   - without the flag: no report file is ever written (existing consumers
 *     that never pass `--spawn-report` run unaffected).
 *   - with the flag: exactly one JSON line is written, before the MCP
 *     transport connects, whose `argv` and `envValue` match the spawn argv
 *     and the env var this test set -- the same two observables
 *     `probe_echo` reports, but readable without any MCP handshake or
 *     model turn.
 *
 * The canary and ledger files are also asserted present in both cases,
 * confirming the new option changes nothing about the fixture's two
 * pre-existing side effects (this file's own header, jobs 1 and 2).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_PATH = join(import.meta.dir, '../fixtures/stdio-echo-mcp-server.ts');
const ENV_VAR_NAME = 'STDIO_ECHO_FIXTURE_TEST_VAR';

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pred();
}

describe('stdio-echo-mcp-server fixture: --spawn-report', () => {
  test('without --spawn-report, canary and ledger appear but no report file is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stdio-echo-fixture-'));
    const canary = join(dir, 'server.touched');
    const ledger = join(dir, 'server-ledger.tsv');
    const report = join(dir, 'server-report.ndjson');
    const args = ['--canary', canary, '--ledger', ledger, '--env-var', ENV_VAR_NAME];
    const proc = Bun.spawn(['bun', FIXTURE_PATH, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, [ENV_VAR_NAME]: 'irrelevant-for-this-case' },
    });
    try {
      expect(await waitFor(() => existsSync(canary))).toBe(true);
      expect(await waitFor(() => existsSync(ledger))).toBe(true);
      // Give the fixture a moment beyond canary/ledger appearing, in case a
      // report were (incorrectly) written asynchronously after them.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(report)).toBe(false);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with --spawn-report, one JSON line carries argv and envValue matching the spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stdio-echo-fixture-'));
    const canary = join(dir, 'server.touched');
    const ledger = join(dir, 'server-ledger.tsv');
    const report = join(dir, 'server-report.ndjson');
    const envValue = `fixture-test-value-${crypto.randomUUID()}`;
    const args = [
      '--canary',
      canary,
      '--ledger',
      ledger,
      '--env-var',
      ENV_VAR_NAME,
      '--spawn-report',
      report,
    ];
    const proc = Bun.spawn(['bun', FIXTURE_PATH, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, [ENV_VAR_NAME]: envValue },
    });
    try {
      expect(await waitFor(() => existsSync(report))).toBe(true);
      expect(existsSync(canary)).toBe(true);
      expect(existsSync(ledger)).toBe(true);

      const reportLines = readFileSync(report, 'utf8').split('\n').filter((l) => l.trim() !== '');
      expect(reportLines.length).toBe(1);
      const parsed = JSON.parse(reportLines[0]) as {
        pid: number;
        starttime: string;
        serverName: string;
        argv: string[];
        envVarName: string;
        envValue: string | null;
        at: string;
      };
      expect(parsed.serverName).toBe('server');
      expect(parsed.envVarName).toBe(ENV_VAR_NAME);
      expect(parsed.envValue).toBe(envValue);
      expect(typeof parsed.pid).toBe('number');
      // process.argv[0] is bun's own binary path (may differ in
      // representation from the literal 'bun' we spawned); only argv[2:]
      // is under this test's control, matching how the fixture itself
      // parses `process.argv.slice(2)`.
      expect(parsed.argv.slice(2)).toEqual(args);

      const ledgerLines = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '');
      expect(ledgerLines.length).toBe(1);
      expect(ledgerLines[0].split('\t')).toHaveLength(4);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
