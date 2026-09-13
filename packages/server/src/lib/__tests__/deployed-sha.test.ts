/**
 * Sibling test for `lib/deployed-sha.ts`.
 *
 * Deliberately uses `Bun.write` / `Bun.file`, not `node:fs` / `node:fs/promises`:
 * this codebase's server test suite process-globally mocks `fs`/`fs/promises`
 * with memfs the moment ANY test file in the same `bun test` process imports
 * `test-utils.ts` (`.claude/rules/testing.md` Anti-Pattern #2), and that
 * mock's virtual root has no `/tmp`. `Bun.file` / `Bun.write` are native Bun
 * APIs that bypass the mock entirely, so a scratch dir under the real
 * `os.tmpdir()` behaves the same whether this file runs alone or as part of
 * the full suite (see `lib/__tests__/artifact-storage.test.ts` for the same
 * rationale applied to that module).
 */
import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readDeployedSha } from '../deployed-sha.js';

/** Unique scratch directory per test; never created eagerly -- `Bun.write` creates it on first write. */
function makeScratchDir(): string {
  return path.join(os.tmpdir(), `agent-console-deployed-sha-test-${randomUUID()}`);
}

async function cleanupMarker(dir: string): Promise<void> {
  await Bun.file(path.join(dir, '.deploy-sha')).delete().catch(() => {});
}

describe('readDeployedSha', () => {
  it('returns null when no marker file exists', async () => {
    const scratchDir = makeScratchDir();
    expect(await readDeployedSha(scratchDir)).toBeNull();
  });

  it('returns the SHA when the marker has SHA + timestamp', async () => {
    const scratchDir = makeScratchDir();
    await Bun.write(path.join(scratchDir, '.deploy-sha'), 'abc123def456\n2026-09-13T12:00:00Z\n');

    try {
      expect(await readDeployedSha(scratchDir)).toBe('abc123def456');
    } finally {
      await cleanupMarker(scratchDir);
    }
  });

  it('returns the SHA when the marker has only a SHA with no trailing newline', async () => {
    const scratchDir = makeScratchDir();
    await Bun.write(path.join(scratchDir, '.deploy-sha'), 'abc123def456');

    try {
      expect(await readDeployedSha(scratchDir)).toBe('abc123def456');
    } finally {
      await cleanupMarker(scratchDir);
    }
  });

  it('returns null and does not throw for an empty marker file', async () => {
    const scratchDir = makeScratchDir();
    await Bun.write(path.join(scratchDir, '.deploy-sha'), '');

    try {
      expect(await readDeployedSha(scratchDir)).toBeNull();
    } finally {
      await cleanupMarker(scratchDir);
    }
  });

  it('trims leading/trailing whitespace on the first line', async () => {
    const scratchDir = makeScratchDir();
    await Bun.write(path.join(scratchDir, '.deploy-sha'), '  abc123def456  \n2026-09-13T12:00:00Z\n');

    try {
      expect(await readDeployedSha(scratchDir)).toBe('abc123def456');
    } finally {
      await cleanupMarker(scratchDir);
    }
  });

  it('returns null for a marker whose first line is whitespace-only', async () => {
    const scratchDir = makeScratchDir();
    await Bun.write(path.join(scratchDir, '.deploy-sha'), '   \n2026-09-13T12:00:00Z\n');

    try {
      expect(await readDeployedSha(scratchDir)).toBeNull();
    } finally {
      await cleanupMarker(scratchDir);
    }
  });
});
