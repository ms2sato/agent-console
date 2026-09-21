import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #1776: `bun run start` reads the root package.json's "start" script
// and spawns a NEW child process to run it -- not a continuation of the
// process that ran `bun run start`. A bare `bun` in that script is resolved
// by whatever the child's $PATH puts first, which under the multi-user
// systemd unit is the SERVICE USER's own bun, not the unified copy named by
// EMBEDDED_AGENT_BUN_PATH -- regardless of which `bun` binary actually
// invoked `run start`. This test proves the property directly by executing
// real processes: with two distinct-inode `bun` copies (A invoked directly,
// B first on PATH), the script's child must execute A, never B.
//
// ~90 MB is copied twice per test run (two full copies of the running
// `bun`'s own binary) -- acceptable, measured cost for a real-execution
// regression lock with no detection-power gap (see the "No string-parse
// pin" note below).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const ROOT_PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

// Reads the REAL root package.json's "start" script and swaps its
// "dist/index.js" target for a tiny probe that prints `process.execPath` --
// upstream of and outside the chain under test (what is executed, not how
// the executor is chosen). Throws if "dist/index.js" does not appear
// exactly once, so the substitution can never silently miss a second
// occurrence or silently no-op on zero.
function readProbeStartScript() {
  const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  const start = pkg.scripts?.start;
  if (typeof start !== 'string') {
    throw new Error(`root package.json has no "scripts.start" string (got ${JSON.stringify(start)})`);
  }
  const occurrences = start.split('dist/index.js').length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `root package.json's "start" script must contain "dist/index.js" exactly once (found ${occurrences}), so this test's substitution stays unambiguous. Script: ${start}`,
    );
  }
  return start.replace('dist/index.js', 'probe.mjs');
}

// Builds a scratch dir with two distinct-inode copies of THIS test
// process's own `bun` binary (`process.execPath`) -- copy A and copy B --
// a package.json whose "start" is `startScript`, and probe.mjs printing
// `process.execPath`. Spawns `<scratch>/a/bun run start` with
// PATH = "<scratch>/b:<minimal system PATH>" (copy B first, copy A never on
// PATH at all) and NO inherited PATH, so the only way the child can
// execute copy A is by construction (the invoking binary), never by
// lookup. Returns the trimmed stdout plus both copies' realpaths.
function runProbe(startScript) {
  const scratch = mkdtempSync(join(tmpdir(), 'start-script-execpath-'));
  try {
    const dirA = join(scratch, 'a');
    const dirB = join(scratch, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const bunA = join(dirA, 'bun');
    const bunB = join(dirB, 'bun');
    copyFileSync(process.execPath, bunA);
    copyFileSync(process.execPath, bunB);
    chmodSync(bunA, 0o755);
    chmodSync(bunB, 0o755);

    const inoA = statSync(bunA).ino;
    const inoB = statSync(bunB).ino;
    if (inoA === inoB) {
      throw new Error(`copy A (${bunA}) and copy B (${bunB}) unexpectedly share inode ${inoA} -- the harness's own precondition failed`);
    }

    // Bun's script runner prepends `<cwd>/node_modules/.bin` and EVERY
    // ancestor directory's `node_modules/.bin` (up to `/node_modules/.bin`)
    // ahead of the inherited PATH -- measured directly: a `bun` entry
    // placed in cwd's node_modules/.bin wins over a PATH-first copy
    // elsewhere. If any ancestor of `scratch` already has a `bun` entry
    // there (host-specific, outside this harness's control), the negative
    // control could pass for THAT reason instead of the PATH-order
    // mechanism it exists to prove -- fail loudly rather than silently
    // reading a false positive.
    let dir = scratch;
    for (;;) {
      const candidate = join(dir, 'node_modules', '.bin', 'bun');
      if (existsSync(candidate)) {
        throw new Error(
          `${candidate} already exists -- Bun's node_modules/.bin ancestor-prepend would resolve bare "bun" to it regardless of PATH, invalidating this harness's premise`,
        );
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'start-script-execpath-scratch', private: true, scripts: { start: startScript } }, null, 2),
    );
    writeFileSync(join(scratch, 'probe.mjs'), 'console.log(process.execPath);\n');

    const minimalSystemPath = ['/usr/bin', '/bin'].join(':');
    const result = spawnSync(bunA, ['run', 'start'], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        PATH: `${dirB}:${minimalSystemPath}`,
        HOME: process.env.HOME ?? scratch,
      },
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `bun run start exited ${result.status} (signal ${result.signal ?? 'none'})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }

    return { stdout: result.stdout.trim(), bunA: realpathSync(bunA), bunB: realpathSync(bunB) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('root package.json "start" script resolves bun by construction, not PATH lookup (#1776)', () => {
  it('current start script: the child executes the SAME bun that ran `bun run start` (copy A), never the PATH-first one (copy B)', () => {
    const probeStart = readProbeStartScript();
    const { stdout, bunA } = runProbe(probeStart);
    expect(stdout).toBe(bunA);
  });

  // No string-parse pin of the script's TEXT is used as the regression
  // lock (a pin like `expect(start).toContain('$npm_execpath')` encodes the
  // mechanism, passes for a broken equivalent, and fails for a working
  // alternative -- see workflow.md "A check's existence is not its
  // detection power"). This control is what makes the case above a
  // reading rather than a blind instrument: it re-runs the IDENTICAL
  // harness against the literal pre-fix (af8fed78) form, as a fixed string
  // independent of whatever the real package.json now contains, and it
  // must ALWAYS resolve the PATH-first copy B. If this control ever
  // started printing copy A instead, the harness itself -- not the
  // production script -- would be broken.
  //
  // What this control does NOT cover: `bun run` can prepend a per-machine
  // temp dir (`/tmp/bun-node-<bun-revision>`, containing `bun`/`node`
  // symlinks) ahead of the inherited PATH under SOME spawn conditions --
  // confirmed on the real multi-user systemd unit (tier 3's arm 7e), whose
  // child process saw this dir first. Measured directly under THIS test's
  // own spawn shape (`spawnSync` with an explicit minimal env, PATH printed
  // from inside the child): bun 1.3.14 does NOT prepend that shim dir here,
  // even when it already exists and points at the exact binary invoked --
  // the child's PATH starts with the node_modules/.bin chain instead. So
  // this control isolates the PATH-order mechanism alone; a machine (or
  // spawn condition) whose environment never triggers the shim reads SAME
  // even pre-fix, for a different reason than the fix, and would need the
  // real-unit reproduction (tier 3's arm 7e) to see the shim's effect. The
  // exact condition that triggers the prepend under a systemd unit's spawn
  // is not established here.
  it('negative control: the pre-fix (af8fed78) bare-`bun` form always resolves the PATH-first copy, never the invoking one', () => {
    const preFixStart = 'NODE_ENV=production bun probe.mjs';
    const { stdout, bunB } = runProbe(preFixStart);
    expect(stdout).toBe(bunB);
  });
});
