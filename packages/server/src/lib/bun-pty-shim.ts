/**
 * Helper for the bundled dist/index.js shim that locates the bun-pty native
 * library next to the bundled server and exposes it via BUN_PTY_LIB.
 *
 * bun-pty's own resolveLibPath() honors BUN_PTY_LIB above all other lookups,
 * so setting it before importing the bundled server is enough to keep the
 * library colocated with dist/ across both single-user (Model A) and
 * multi-user (Model B) deployment shapes — they have different `here`
 * derivations in bun-pty's resolver but neither matches a path inside dist/.
 *
 * The functions in this file are kept pure (no fs / process side effects)
 * so they can be unit tested with an injected predicate and reused as the
 * single source of truth for the shim runtime.
 */

import { join } from 'node:path';

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';
export type SupportedArch = 'arm64' | 'x64';

/**
 * Returns the candidate native library filenames for a given platform/arch,
 * in priority order (most specific first). Mirrors bun-pty's own resolver
 * exactly so a future bun-pty bump only requires updating this table.
 */
export function getLibCandidateFilenames(
  platform: NodeJS.Platform,
  arch: string
): string[] {
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? ['librust_pty_arm64.dylib', 'librust_pty.dylib']
      : ['librust_pty.dylib'];
  }
  if (platform === 'win32') {
    return ['rust_pty.dll'];
  }
  // linux + anything else falls through to the .so table
  return arch === 'arm64'
    ? ['librust_pty_arm64.so', 'librust_pty.so']
    : ['librust_pty.so'];
}

/**
 * Resolves the bun-pty native library path for the running platform.
 *
 * Order:
 *   1. If process.env.BUN_PTY_LIB is set and points to an existing file, use it
 *      (operator escape hatch — never overwritten).
 *   2. Otherwise look under `<here>/rust-pty/target/release/<candidate>` for the
 *      platform's candidate filenames, returning the first match.
 *
 * Returns the resolved absolute path, or null if nothing exists.
 *
 * @param here          Directory containing the shim (i.e. dist/).
 * @param platform      process.platform value.
 * @param arch          process.arch value.
 * @param envValue      Current value of process.env.BUN_PTY_LIB (or undefined).
 * @param existsFn      Predicate that returns true if a path exists. Injected
 *                      so tests do not need to touch the real fs.
 */
export function findLibPath(
  here: string,
  platform: NodeJS.Platform,
  arch: string,
  envValue: string | undefined,
  existsFn: (path: string) => boolean
): string | null {
  if (envValue && envValue.length > 0 && existsFn(envValue)) {
    return envValue;
  }
  const candidates = getLibCandidateFilenames(platform, arch);
  const baseDir = join(here, 'rust-pty', 'target', 'release');
  for (const filename of candidates) {
    const candidatePath = join(baseDir, filename);
    if (existsFn(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * Builds the human-readable error message used when no library can be found.
 * Extracted so the shim's error formatting is covered by tests.
 */
export function formatLibNotFoundError(
  here: string,
  platform: NodeJS.Platform,
  arch: string,
  envValue: string | undefined
): string {
  const candidates = getLibCandidateFilenames(platform, arch);
  const baseDir = join(here, 'rust-pty', 'target', 'release');
  const checked = candidates.map((f) => `  - ${join(baseDir, f)}`).join('\n');
  return (
    `bun-pty native library not found next to the bundled server.\n` +
    `  BUN_PTY_LIB=${envValue ?? '<unset>'}\n` +
    `  platform=${platform} arch=${arch}\n` +
    `Checked:\n${checked}\n\n` +
    `The library should have been copied into dist/rust-pty/target/release/ at build time. ` +
    `Re-run the build, or set BUN_PTY_LIB to an absolute path to the .dylib / .so / .dll.`
  );
}
