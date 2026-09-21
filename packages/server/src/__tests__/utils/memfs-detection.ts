/**
 * Detect whether `fs`/`node:fs`/`fs/promises` have been swapped for memfs by
 * an earlier test file's `mock.module` call (see `mock-fs-helper.ts`).
 * `mock.module` is process-global in bun:test (see `.claude/rules/testing.md`
 * "Module-Level Mocking" anti-pattern), so any test file that runs real-fs
 * probes (kernel-level PTY/fd checks, mode/ownership checks, etc.) needs to
 * detect this and skip gracefully rather than fail against the in-memory
 * simulation.
 *
 * Sentinel: `/proc` exists on every Linux real fs but is not populated in the
 * memfs volume.
 */
export async function isMemfsActive(): Promise<boolean> {
  try {
    const fsp = await import('fs/promises');
    await fsp.lstat('/proc');
    return false;
  } catch {
    return true;
  }
}

/**
 * Assert that the CURRENT process has NOT had `fs`/`fs/promises` swapped
 * for memfs. A real-fs test that finds memfs active is a wiring error, not
 * something to skip gracefully: it means the test wasn't listed in
 * `packages/server/package.json`'s second `bun test` invocation, or it
 * ended up sharing a process with a `mock-fs-helper` importer.
 */
export async function assertRealFs(label: string): Promise<void> {
  if (await isMemfsActive()) {
    throw new Error(
      `${label}: this real-fs test is running under memfs -- it must be listed in packages/server/package.json's second bun test invocation and must not share a process with a mock-fs-helper importer`,
    );
  }
}
