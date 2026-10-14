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
import {
  writeArtifactFile,
  replaceArtifactFile,
  moveFileAtomically,
  readArtifactFile,
  deleteArtifactFile,
} from '../artifact-storage.js';
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

  describe('replaceArtifactFile', () => {
    // Directory listing through Bun's own glob: real disk, outside any
    // process-global memfs interception (same reason the module is Bun-native).
    const listDir = (dir: string): string[] => [...new Bun.Glob('*').scanSync({ cwd: dir, dot: true })].sort();

    it('replaces the content in place at the same path', async () => {
      written.push({ userId: 'user-r1', artifactId: 'artifact-r1' });
      await writeArtifactFile('user-r1', 'artifact-r1', '<p>old</p>');

      await replaceArtifactFile('user-r1', 'artifact-r1', '<p>new, and longer</p>');

      expect(await readArtifactFile('user-r1', 'artifact-r1')).toBe('<p>new, and longer</p>');
    });

    it('leaves no temp file behind after a successful replace', async () => {
      written.push({ userId: 'user-r2', artifactId: 'artifact-r2' });
      await writeArtifactFile('user-r2', 'artifact-r2', 'a');
      await replaceArtifactFile('user-r2', 'artifact-r2', 'b');

      const dir = path.dirname(getArtifactFilePath('user-r2', 'artifact-r2'));
      expect(listDir(dir)).toEqual(['artifact-r2.html']);
    });

    it('moves paths as single arguments: a path with a space AND shell metacharacters ($, quotes, ;, *) is replaced intact', async () => {
      const userId = 'user $HOME r4';
      const artifactId = "artifact `x` ; *'r4";
      written.push({ userId, artifactId });
      await writeArtifactFile(userId, artifactId, 'old');

      await replaceArtifactFile(userId, artifactId, 'new');

      expect(await readArtifactFile(userId, artifactId)).toBe('new');
      const dir = path.dirname(getArtifactFilePath(userId, artifactId));
      expect(listDir(dir)).toEqual([path.basename(getArtifactFilePath(userId, artifactId))]);
    });

    it('moveFileAtomically refuses a move across directories and leaves both files untouched', async () => {
      written.push({ userId: 'user-r5a', artifactId: 'artifact-r5a' }, { userId: 'user-r5b', artifactId: 'artifact-r5b' });
      await writeArtifactFile('user-r5a', 'artifact-r5a', 'a');
      await writeArtifactFile('user-r5b', 'artifact-r5b', 'b');

      await expect(
        moveFileAtomically(getArtifactFilePath('user-r5a', 'artifact-r5a'), getArtifactFilePath('user-r5b', 'artifact-r5b')),
      ).rejects.toThrow('non-atomic move across directories');

      expect(await readArtifactFile('user-r5a', 'artifact-r5a')).toBe('a');
      expect(await readArtifactFile('user-r5b', 'artifact-r5b')).toBe('b');
    });

    it('a failure between the temp write and the rename leaves the OLD bytes intact and no temp file', async () => {
      written.push({ userId: 'user-r3', artifactId: 'artifact-r3' });
      await writeArtifactFile('user-r3', 'artifact-r3', '<p>old bytes</p>');
      const failingMove = async () => {
        throw new Error('simulated rename failure');
      };

      await expect(
        replaceArtifactFile('user-r3', 'artifact-r3', '<p>new bytes</p>', { moveFile: failingMove }),
      ).rejects.toThrow('simulated rename failure');

      expect(await readArtifactFile('user-r3', 'artifact-r3')).toBe('<p>old bytes</p>');
      const dir = path.dirname(getArtifactFilePath('user-r3', 'artifact-r3'));
      // No temp file survives the failure (the temp was written before the move failed).
      expect(listDir(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
      expect(listDir(dir)).toEqual(['artifact-r3.html']);
    });
  });
});
