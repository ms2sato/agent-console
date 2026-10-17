/**
 * `isolateClaudeConfigDir` owns the cleanup of the dirs it creates: each holds
 * a COPY of the operator's credentials file, so a dir that outlives the run is
 * a secret at rest in the temp directory. Free: no `claude` session is started
 * and the credentials are a fake file.
 *
 * Each case runs the helper in a CHILD `bun` process with HOME pointing at a
 * temp dir. A child is needed because Bun resolves `os.homedir()` once at
 * startup, so changing HOME inside the test process never reaches the helper;
 * it also lets the real `process.once('exit')` and SIGTERM paths run for real,
 * instead of being simulated, without leaving handlers on the test process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HARNESS = resolve(import.meta.dir, '../probe-sdk-session-harness.ts');
const LABEL = 'isolation-test';
const FAKE_CREDENTIALS = '{"fake":"credentials"}';

const listIsolationDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(`probe-sdk-${LABEL}-`));

/** Child program: call the helper twice, report, then run `tail`. Prints one JSON line. */
function childProgram(tail: string): string {
  return `
    import { existsSync, readFileSync, statSync } from 'node:fs';
    import { join } from 'node:path';
    import { isolateClaudeConfigDir, cleanupIsolatedConfigDirs } from ${JSON.stringify(HARNESS)};
    const SIGNALS = ['SIGINT', 'SIGTERM'];
    const count = () => ({ exit: process.listenerCount('exit'), SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') });
    const before = count();
    const a = isolateClaudeConfigDir(${JSON.stringify(LABEL)});
    const afterFirst = count();
    const b = isolateClaudeConfigDir(${JSON.stringify(LABEL)});
    const afterSecond = count();
    const info = (d) => ({ dir: d, exists: existsSync(d), creds: readFileSync(join(d, '.credentials.json'), 'utf8'), mode: statSync(join(d, '.credentials.json')).mode & 0o777 });
    const report = { a: info(a), b: info(b), envIsLast: process.env.CLAUDE_CONFIG_DIR === b,
      firstDelta: Object.fromEntries(Object.keys(before).map((k) => [k, afterFirst[k] - before[k]])),
      secondDelta: Object.fromEntries(Object.keys(before).map((k) => [k, afterSecond[k] - afterFirst[k]])) };
    ${tail}
  `;
}

interface ChildReport {
  a: { dir: string; exists: boolean; creds: string; mode: number };
  b: { dir: string; exists: boolean; creds: string; mode: number };
  envIsLast: boolean;
  firstDelta: Record<string, number>;
  secondDelta: Record<string, number>;
  afterCleanup?: { aGone: boolean; bGone: boolean; secondCallThrew: boolean };
}

describe('isolateClaudeConfigDir helper-owned cleanup', () => {
  let fakeHome = '';
  const dirsBefore = new Set<string>();

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'probe-home-test-'));
    mkdirSync(join(fakeHome, '.claude'));
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), FAKE_CREDENTIALS, { mode: 0o644 });
    for (const d of listIsolationDirs()) dirsBefore.add(d);
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const newDirs = (): string[] => listIsolationDirs().filter((d) => !dirsBefore.has(d));
  const runChild = (program: string) =>
    Bun.spawnSync(['bun', '-e', program], { env: { ...process.env, HOME: fakeHome }, stdout: 'pipe', stderr: 'pipe' });
  const parse = (stdout: Uint8Array): ChildReport => JSON.parse(new TextDecoder().decode(stdout).trim().split('\n').at(-1) ?? '') as ChildReport;

  it('copies the credentials at mode 0600, installs the handlers exactly once across two calls, and the cleanup removes both dirs idempotently', () => {
    const r = runChild(
      childProgram(`
        cleanupIsolatedConfigDirs();
        let threw = false;
        try { cleanupIsolatedConfigDirs(); } catch { threw = true; }
        report.afterCleanup = { aGone: !existsSync(a), bGone: !existsSync(b), secondCallThrew: threw };
        console.log(JSON.stringify(report));
      `),
    );
    expect(r.exitCode).toBe(0);
    const report = parse(r.stdout);
    for (const side of [report.a, report.b]) {
      expect(side.exists).toBe(true);
      expect(side.creds).toBe(FAKE_CREDENTIALS);
      expect(side.mode).toBe(0o600);
    }
    expect(report.envIsLast).toBe(true);
    expect(report.firstDelta).toEqual({ exit: 1, SIGINT: 1, SIGTERM: 1 });
    expect(report.secondDelta).toEqual({ exit: 0, SIGINT: 0, SIGTERM: 0 });
    expect(report.afterCleanup).toEqual({ aGone: true, bGone: true, secondCallThrew: false });
  });

  it('removes the dirs on a normal process exit, with no caller cleanup', () => {
    const r = runChild(childProgram('console.log(JSON.stringify(report));'));
    expect(r.exitCode).toBe(0);
    const report = parse(r.stdout);
    expect(report.a.exists).toBe(true);
    expect(existsSync(report.a.dir)).toBe(false);
    expect(existsSync(report.b.dir)).toBe(false);
  });

  it('removes the dirs on SIGTERM and then dies of that signal (default behaviour re-raised)', async () => {
    const proc = Bun.spawn(['bun', '-e', childProgram('console.log(JSON.stringify(report)); setInterval(() => {}, 1000);')], {
      env: { ...process.env, HOME: fakeHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    let text = '';
    while (!text.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const report = JSON.parse(text.trim().split('\n').at(-1) ?? '') as ChildReport;
    expect(existsSync(report.a.dir)).toBe(true);
    proc.kill('SIGTERM');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGTERM');
    expect(existsSync(report.a.dir)).toBe(false);
    expect(existsSync(report.b.dir)).toBe(false);
  });

  it('leaves no probe-sdk-isolation-test-* dir behind', () => {
    expect(newDirs()).toEqual([]);
  });
});
