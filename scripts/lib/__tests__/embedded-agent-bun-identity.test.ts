import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markerFor, selfExeFor } from '../embedded-agent-bun-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(__dirname, '..', 'embedded-agent-bun-identity.ts');

// The identity entry behind the post-deploy verification's V3 (Issue #1717):
// `<bun> embedded-agent-bun-identity.ts <pid|self-exe> <configured>` prints
// ONE marker that mainpid_identity (scripts/lib/setup-multiuser-checks.sh)
// maps to PASS / FAIL / cannot-run. Run as a real subprocess with REAL files
// -- no fake `realpath` seam is needed, because every one of the five
// markers is reachable with paths that exist (or do not) on any Linux box:
//
//   SAME                    /proc/self/exe vs the realpath of this bun
//   DIFFERENT               /proc/self/exe vs /bin/true
//   UNRESOLVABLE:self       a pid that cannot exist (the pid -> /proc/<pid>/exe
//                           branch, which is what the deploy script uses)
//   UNRESOLVABLE:configured /proc/self/exe vs a path that does not exist
//   UNRESOLVABLE:bare       a bare name (no realpath is ever attempted)
//
// The subprocess bun IS the interpreter the marker is about, so "SAME"
// compares the child's own /proc/self/exe with the same binary this test
// runner resolved -- the same shape the elevation smoke's positive control
// uses (check-embedded-agent-elevation.ts).
function run(args: string[], extraArgv: string[] = []) {
  return spawnSync(process.execPath, [ENTRY, ...args, ...extraArgv], { encoding: 'utf-8' });
}

const BUN_REAL = realpathSync(process.execPath);

describe('scripts/lib/embedded-agent-bun-identity.ts: one marker per compareBinaryIdentity result', () => {
  it('SAME: /proc/self/exe vs the realpath of the running bun -> SAME, exit 0, nothing else on stdout', () => {
    const r = run(['/proc/self/exe', BUN_REAL]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('SAME\n');
    expect(r.stderr).toBe('');
  });

  it('SAME through a symlink: a symlink to the bun binary resolves to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bun-identity-'));
    try {
      const link = join(dir, 'bun-link');
      spawnSync('ln', ['-s', BUN_REAL, link]);
      const r = run(['/proc/self/exe', link]);
      expect(r.stdout).toBe('SAME\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DIFFERENT: /proc/self/exe vs /bin/true -> DIFFERENT, exit 0', () => {
    const r = run(['/proc/self/exe', '/bin/true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('DIFFERENT\n');
  });

  it('UNRESOLVABLE:self via the pid branch: a pid that cannot exist -> /proc/<pid>/exe is ENOENT', () => {
    // 4194304 is one past the Linux PID_MAX_LIMIT (2^22), so no process
    // can ever carry it.
    const r = run(['4194304', '/bin/true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('UNRESOLVABLE:self\n');
  });

  it('UNRESOLVABLE:configured: an absolute path that does not exist', () => {
    const r = run(['/proc/self/exe', '/nonexistent/unified-bun-for-test']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('UNRESOLVABLE:configured\n');
  });

  it('UNRESOLVABLE:bare: a bare command name, never realpath\'d', () => {
    const r = run(['/proc/self/exe', 'bun']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('UNRESOLVABLE:bare\n');
  });

  it('missing arguments -> exit 2, NO marker on stdout (the cannot-run shape the lib reads as "no marker")', () => {
    for (const args of [[], ['/proc/self/exe']]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('usage:');
    }
  });

  it('a trailing hostile argument is ignored (only the first two argv slots are read)', () => {
    const r = run(['/proc/self/exe', BUN_REAL], ['--definitely-not-a-flag']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('SAME\n');
  });
});

describe('scripts/lib/embedded-agent-bun-identity.ts: pure helpers and import safety', () => {
  it('markerFor maps every BinaryIdentity value to exactly one marker', () => {
    expect(markerFor('same')).toBe('SAME');
    expect(markerFor('different')).toBe('DIFFERENT');
    expect(markerFor({ unresolvable: 'self' })).toBe('UNRESOLVABLE:self');
    expect(markerFor({ unresolvable: 'configured' })).toBe('UNRESOLVABLE:configured');
    expect(markerFor({ unresolvable: 'bare' })).toBe('UNRESOLVABLE:bare');
  });

  it('selfExeFor: digits are a MainPID (-> /proc/<pid>/exe), anything else is used verbatim', () => {
    expect(selfExeFor('552')).toBe('/proc/552/exe');
    expect(selfExeFor('/proc/self/exe')).toBe('/proc/self/exe');
  });

  it('importing the module runs nothing (import.meta.main guard): a subprocess import prints no marker and exits 0', () => {
    // scripts/smoke/__tests__/import-safety.test.ts's glob covers
    // scripts/smoke only, so this file carries the guard's own pin for
    // scripts/lib. Subprocess-isolated for the same reason that test is: a
    // regressed guard would print a marker (or process.exit) inside the
    // importer.
    const r = spawnSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(ENTRY)}).then(() => console.log('IMPORT_OK'))`],
      { encoding: 'utf-8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('IMPORT_OK\n');
    expect(r.stderr).toBe('');
  });
});
