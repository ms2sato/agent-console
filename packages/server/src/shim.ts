/**
 * Bundled entry point for dist/index.js.
 *
 * Responsibilities:
 *   1. Locate the bun-pty native library that build.ts copied into
 *      dist/rust-pty/target/release/ for the current platform.
 *   2. Export the discovered path via process.env.BUN_PTY_LIB so that the
 *      real server bundle (dist/server.js) — which transitively imports
 *      bun-pty at module load time — can resolve the library regardless of
 *      cwd or deployment shape (single-user / multi-user).
 *   3. Dynamic-import the real server bundle.
 *
 * Kept intentionally tiny. All fs / platform logic lives in
 * ./lib/bun-pty-shim.ts so it can be unit tested without the bundle.
 *
 * The dynamic import of './server.js' is marked external in build.ts so the
 * bundler does not inline the server into the shim.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findLibPath,
  formatLibNotFoundError,
} from './lib/bun-pty-shim.js';

const here = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
const arch = process.arch;
const envValue = process.env.BUN_PTY_LIB;

const resolved = findLibPath(here, platform, arch, envValue, existsSync);
if (resolved === null) {
  throw new Error(formatLibNotFoundError(here, platform, arch, envValue));
}

// Only set when we discovered it ourselves; preserve any operator override.
if (resolved !== envValue) {
  process.env.BUN_PTY_LIB = resolved;
}

// The sibling server bundle is loaded dynamically. The path is computed at
// runtime so the bundler does not try to resolve and inline it during the
// shim build step.
const serverUrl = new URL('./server.js', import.meta.url).href;
await import(serverUrl);
