/**
 * TEMPORARY diagnostic test for Issue #1225. Removed before PR finalization.
 * Runs the same probe as scripts/debug-1225-open-probe.mjs, but inside a
 * bun:test process with the packages/integration preload (happy-dom
 * GlobalRegistrator), to isolate whether the preload alone changes
 * ChildProcess#unref() behavior on the CI runner.
 */
import { describe, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';

function tryUnref(label: string, cmd: string, args: string[]) {
  console.log(`\n[${label}] spawn(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  let subprocess;
  try {
    subprocess = spawn(cmd, args, { stdio: 'ignore' });
  } catch (err) {
    console.log(`[${label}] spawn() threw synchronously:`, (err as Error)?.message);
    return;
  }
  try {
    subprocess.unref();
    console.log(`[${label}] unref() succeeded, no throw`);
  } catch (err) {
    console.log(`[${label}] unref() THREW:`, (err as Error)?.message);
  }
  subprocess.once('error', (err) => {
    console.log(`[${label}] later 'error' event:`, (err as Error)?.message);
  });
  subprocess.once('spawn', () => {
    console.log(`[${label}] later 'spawn' event fired (spawn succeeded)`);
  });
}

describe('Issue #1225 open() probe (under bun:test + preload)', () => {
  it('runs the probe', async () => {
    console.log('--- Issue #1225 open() probe (bun:test + preload) ---');
    console.log('bun version:', (process.versions as { bun?: string }).bun ?? '(not bun)');

    tryUnref('A-existing-binary', 'true', []);
    tryUnref('B-missing-binary', 'this-binary-does-not-exist-1225-probe', []);

    console.log('\n[C-open-package] which xdg-open on PATH:');
    try {
      console.log(execSync('which xdg-open').toString().trim());
    } catch (err) {
      console.log('xdg-open NOT found on PATH:', (err as Error)?.message);
    }

    try {
      const openPkgPath = new URL('../../server/node_modules/open/xdg-open', import.meta.url);
      const st = statSync(openPkgPath);
      console.log('[C-open-package] bundled xdg-open mode:', (st.mode & 0o777).toString(8));
    } catch (err) {
      console.log('[C-open-package] could not stat bundled xdg-open:', (err as Error)?.message);
    }

    console.log('\n[C-open-package] calling open("/tmp") from the actual npm package:');
    try {
      const openModuleUrl = new URL('../../server/node_modules/open/index.js', import.meta.url);
      const { default: open } = await import(openModuleUrl.href);
      const subprocess = await open('/tmp');
      console.log('[C-open-package] open() resolved successfully, pid:', subprocess?.pid);
    } catch (err) {
      console.log('[C-open-package] open() THREW/REJECTED:', (err as Error)?.message);
    }

    console.log('\n--- probe complete ---');
  });
});
