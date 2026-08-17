/**
 * Sibling test for `lib/artifact-storage.ts` (Issue #1312, phase 1).
 *
 * Deliberately uses the REAL filesystem under `os.tmpdir()`, not memfs:
 * `Bun.write` / `Bun.file` are native APIs that bypass the process-global
 * `mock.module('fs/promises')` interception other test files install
 * (`.claude/rules/testing.md` Anti-Pattern #2). Cleanup goes through the
 * module's own Bun-native `deleteArtifactFile` for the same reason -- a
 * `node:fs` cleanup call could silently target a mocked memfs volume
 * instead of the real files this test actually wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { writeArtifactFile, readArtifactFile, deleteArtifactFile } from '../artifact-storage.js';
import { getArtifactFilePath } from '../config.js';

describe('artifact-storage', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let written: Array<{ userId: string; artifactId: string }>;

  beforeEach(() => {
    process.env.AGENT_CONSOLE_HOME = path.join(os.tmpdir(), `agent-console-artifact-storage-test-${randomUUID()}`);
    written = [];
  });

  afterEach(async () => {
    for (const { userId, artifactId } of written) {
      await deleteArtifactFile(userId, artifactId).catch(() => {});
    }
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  it('writes content that can be read back byte-for-byte', async () => {
    written.push({ userId: 'user-1', artifactId: 'artifact-1' });
    await writeArtifactFile('user-1', 'artifact-1', '<html><body>hi</body></html>');

    const content = await readArtifactFile('user-1', 'artifact-1');
    expect(content).toBe('<html><body>hi</body></html>');
  });

  it('creates the per-user directory automatically (no pre-existing dir required)', async () => {
    written.push({ userId: 'user-2', artifactId: 'artifact-2' });
    await writeArtifactFile('user-2', 'artifact-2', '<p>x</p>');

    const filePath = getArtifactFilePath('user-2', 'artifact-2');
    expect(await Bun.file(filePath).exists()).toBe(true);
  });

  it('readArtifactFile returns null for a non-existent artifact', async () => {
    const content = await readArtifactFile('user-3', 'does-not-exist');
    expect(content).toBeNull();
  });

  it('overwriting an artifact id replaces the previous content', async () => {
    written.push({ userId: 'user-6', artifactId: 'artifact-6' });
    await writeArtifactFile('user-6', 'artifact-6', 'first');
    await writeArtifactFile('user-6', 'artifact-6', 'second');

    expect(await readArtifactFile('user-6', 'artifact-6')).toBe('second');
  });

  it('deleteArtifactFile removes the file', async () => {
    await writeArtifactFile('user-4', 'artifact-4', '<p>bye</p>');
    await deleteArtifactFile('user-4', 'artifact-4');

    expect(await readArtifactFile('user-4', 'artifact-4')).toBeNull();
  });

  it('deleteArtifactFile does not throw when the file does not exist', async () => {
    await expect(deleteArtifactFile('user-5', 'never-written')).resolves.toBeUndefined();
  });
});
