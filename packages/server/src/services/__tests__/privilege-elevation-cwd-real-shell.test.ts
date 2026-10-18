/**
 * Runs the inner shell strings the elevated runner (`buildInnerCommand`) and the
 * elevated PTY path (`buildElevationArgs`) build against a REAL `sh` and a REAL
 * directory, so "a failed cd never reaches the command" is observed, not read off
 * the string. A command that leaves a sentinel file when it runs is the observable:
 * the sentinel must be absent when the cwd is missing and present when it exists.
 *
 * Real-fs placement: the fixtures need a directory a real `sh` can see, so this
 * file runs in the second (real-fs) `bun test` invocation (`package.json`) and
 * calls `assertRealFs` first. The builders are obtained from a fresh `bun` child
 * because `privilege-elevation.js` and `elevation-args.js` may be replaced
 * process-globally by mocks in sibling test files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVILEGE_ELEVATION_TS = join(SERVICES_DIR, 'privilege-elevation.ts');
const ELEVATION_ARGS_TS = join(SERVICES_DIR, 'elevation-args.ts');

let workDir: string;
let existingCwd: string;
let missingCwd: string;
let sentinel: string;

async function runShell(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** Evaluates `expression` (JSON-serialisable result) in a fresh bun child. */
async function evalInChild<T>(imports: string, expression: string, args: string[]): Promise<T> {
  const script = `${imports}\nconsole.log(JSON.stringify(${expression}));`;
  const r = await runShell(['bun', '-e', script, ...args], workDir);
  if (r.code !== 0) throw new Error(`child failed (${r.code}): ${r.err}`);
  return JSON.parse(r.out.trim().split('\n').pop()!) as T;
}

/** The real `buildInnerCommand(command, cwd, env)`. */
function buildInner(command: string, cwd: string, env?: Record<string, string>): Promise<string> {
  return evalInChild<string>(
    `import { buildInnerCommand } from ${JSON.stringify(PRIVILEGE_ELEVATION_TS)};`,
    'buildInnerCommand(process.argv[1], process.argv[2], JSON.parse(process.argv[3]) ?? undefined)',
    [command, cwd, JSON.stringify(env ?? null)],
  );
}

/** The real `buildElevationArgs(...).innerCommand`. */
function buildPtyInner(command: string, cwd: string): Promise<string> {
  return evalInChild<string>(
    `import { buildElevationArgs } from ${JSON.stringify(ELEVATION_ARGS_TS)};`,
    'buildElevationArgs({ username: "alice", cwd: process.argv[2], additionalEnvVars: {}, command: process.argv[1] }).innerCommand',
    [command, cwd],
  );
}

const TOUCH_SENTINEL = () => `touch ${JSON.stringify(sentinel)}; echo ran`;

describe('cwd guard in a real shell', () => {
  beforeAll(async () => {
    await assertRealFs('privilege-elevation-cwd-real-shell');
    workDir = await mkdtemp(join(tmpdir(), 'cwd-guard-'));
    existingCwd = join(workDir, 'exists');
    await mkdir(existingCwd);
    missingCwd = join(workDir, 'gone');
    sentinel = join(workDir, 'sentinel');
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true });
  });

  describe('buildInnerCommand', () => {
    it('cwd missing: the command does not run, nothing on stdout, exit 125', async () => {
      const inner = await buildInner(TOUCH_SENTINEL(), missingCwd);
      const r = await runShell(['sh', '-c', inner], workDir);
      expect(r.code).toBe(125);
      expect(r.out).toBe('');
      expect(existsSync(sentinel)).toBe(false);
    });

    it('cwd missing with env: the exports and the command are both skipped', async () => {
      const inner = await buildInner(`${TOUCH_SENTINEL()}; echo "$GUARD_PROBE"`, missingCwd, { GUARD_PROBE: 'set' });
      const r = await runShell(['sh', '-c', inner], workDir);
      expect(r.code).toBe(125);
      expect(r.out).toBe('');
      expect(existsSync(sentinel)).toBe(false);
    });

    it('positive control: cwd exists, the command runs in it and the exit code is the command\'s', async () => {
      const inner = await buildInner(`${TOUCH_SENTINEL()}; pwd`, existingCwd);
      const r = await runShell(['sh', '-c', inner], workDir);
      expect(r.code).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(r.out).toContain('ran');
      expect(r.out.trim().endsWith(existingCwd)).toBe(true);
      await rm(sentinel);
    });
  });

  describe('buildElevationArgs inner command (PTY login path)', () => {
    it('cwd missing: prints a clear line on stderr, exits 125, the shell command never runs', async () => {
      const inner = await buildPtyInner(TOUCH_SENTINEL(), missingCwd);
      const r = await runShell(['sh', '-c', inner], workDir);
      expect(r.code).toBe(125);
      expect(r.out).toBe('');
      expect(r.err).toContain(`agent-console: working directory ${missingCwd} is not available`);
      expect(existsSync(sentinel)).toBe(false);
    });

    it('positive control: cwd exists, the command runs and the exports are applied', async () => {
      const inner = await buildPtyInner(`${TOUCH_SENTINEL()}; echo "$COLORTERM"`, existingCwd);
      const r = await runShell(['sh', '-c', inner], workDir);
      expect(r.code).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(r.out).toContain('truecolor');
      await rm(sentinel);
    });
  });
});
