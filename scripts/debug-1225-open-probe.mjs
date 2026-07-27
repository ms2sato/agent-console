#!/usr/bin/env bun
// TEMPORARY diagnostic script for Issue #1225. Removed before PR finalization.
// Determines whether open@11.0.0's subprocess.unref() throws
// "this.#handle.unref is not a function" unconditionally on this runner,
// or only when the launcher binary fails to spawn.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';

console.log('--- Issue #1225 open() probe ---');
console.log('bun version:', process.versions.bun ?? '(not bun)');
console.log('platform:', process.platform);

function tryUnref(label, cmd, args) {
  console.log(`\n[${label}] spawn(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  let subprocess;
  try {
    subprocess = spawn(cmd, args, { stdio: 'ignore' });
  } catch (err) {
    console.log(`[${label}] spawn() threw synchronously:`, err && err.message);
    return;
  }
  try {
    subprocess.unref();
    console.log(`[${label}] unref() succeeded, no throw`);
  } catch (err) {
    console.log(`[${label}] unref() THREW:`, err && err.message);
  }
  subprocess.once('error', (err) => {
    console.log(`[${label}] later 'error' event:`, err && err.message);
  });
  subprocess.once('spawn', () => {
    console.log(`[${label}] later 'spawn' event fired (spawn succeeded)`);
  });
}

// Test A: command that definitely exists and can spawn successfully.
tryUnref('A-existing-binary', 'true', []);

// Test B: command that definitely does not exist -> spawn ENOENT.
tryUnref('B-missing-binary', 'this-binary-does-not-exist-1225-probe', []);

// Test C: actual production code path via the 'open' package.
console.log('\n[C-open-package] which xdg-open on PATH:');
try {
  console.log(execSync('which xdg-open').toString().trim());
} catch (err) {
  console.log('xdg-open NOT found on PATH:', err && err.message);
}

try {
  const openPkgPath = new URL('../packages/server/node_modules/open/xdg-open', import.meta.url);
  const st = statSync(openPkgPath);
  console.log('[C-open-package] bundled xdg-open mode:', (st.mode & 0o777).toString(8));
} catch (err) {
  console.log('[C-open-package] could not stat bundled xdg-open:', err && err.message);
}

console.log('\n[C-open-package] calling open("/tmp") from the actual npm package (resolved from packages/server):');
try {
  const openModuleUrl = new URL('../packages/server/node_modules/open/index.js', import.meta.url);
  const { default: open } = await import(openModuleUrl.href);
  const subprocess = await open('/tmp');
  console.log('[C-open-package] open() resolved successfully, pid:', subprocess && subprocess.pid);
} catch (err) {
  console.log('[C-open-package] open() THREW/REJECTED:', err && err.message);
}

console.log('\n--- probe complete ---');
