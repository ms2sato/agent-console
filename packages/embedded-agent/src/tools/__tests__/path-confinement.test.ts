import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveConfinedPath, isPathWithinRoots, CONFINEMENT_REJECTED_MESSAGE } from '../path-confinement.js';

describe('resolveConfinedPath', () => {
  let locationPath: string;
  let outsideDir: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-confine-'));
    outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-outside-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
    await fsPromises.rm(outsideDir, { recursive: true, force: true });
  });

  it('confines an absolute path inside locationPath, existing or not', async () => {
    const existing = path.join(locationPath, 'README.md');
    await fsPromises.writeFile(existing, 'hi');
    const notYetExisting = path.join(locationPath, 'not-yet.md');

    const r1 = await resolveConfinedPath(existing, locationPath);
    expect(r1.ok).toBe(true);

    const r2 = await resolveConfinedPath(notYetExisting, locationPath);
    expect(r2.ok).toBe(true);
  });

  it('rejects an absolute path outside locationPath (/etc/passwd)', async () => {
    const result = await resolveConfinedPath('/etc/passwd', locationPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
    }
  });

  it('rejects an absolute path outside locationPath (sibling temp dir)', async () => {
    const target = path.join(outsideDir, 'private.txt');
    const result = await resolveConfinedPath(target, locationPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
    }
  });

  it('rejects a symlink inside locationPath pointing outside it', async () => {
    const outsideTarget = path.join(outsideDir, 'secret.txt');
    await fsPromises.writeFile(outsideTarget, 'secret');
    const linkPath = path.join(locationPath, 'escape-link');
    await fsPromises.symlink(outsideTarget, linkPath);

    const result = await resolveConfinedPath(linkPath, locationPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
    }
  });

  it('confines a relative path resolved against locationPath', async () => {
    const result = await resolveConfinedPath('README.md', locationPath);
    expect(result.ok).toBe(true);
  });

  it('confines locationPath itself (boundary: resolved path EQUALS locationPath)', async () => {
    const result = await resolveConfinedPath('.', locationPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolvedLocation = await fsPromises.realpath(locationPath);
      expect(result.resolvedPath).toBe(resolvedLocation);
    }
  });

  it('confines locationPath given as an absolute bare path', async () => {
    const result = await resolveConfinedPath(locationPath, locationPath);
    expect(result.ok).toBe(true);
  });

  describe('non-existent-segment escape shapes', () => {
    it('rejects an escape through a non-existent middle segment', async () => {
      const result = await resolveConfinedPath('foo/nonexistent/../../..', locationPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
      }
    });

    it('rejects a relative escape climbing above locationPath', async () => {
      const result = await resolveConfinedPath('../../etc/hosts', locationPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
      }
    });

    it('rejects a chained non-existent-segment escape', async () => {
      const result = await resolveConfinedPath('nonexistent/../../..', locationPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
      }
    });

    it('accepts a normalized relative path that stays inside locationPath', async () => {
      const nested = path.join(locationPath, 'foo', 'bar');
      await fsPromises.mkdir(path.dirname(nested), { recursive: true });
      await fsPromises.writeFile(nested, 'hi');

      const result = await resolveConfinedPath('./foo/bar', locationPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const resolvedNested = await fsPromises.realpath(nested);
        expect(result.resolvedPath).toBe(resolvedNested);
      }
    });
  });

  describe('extraRoots (#1570)', () => {
    it('confines an absolute path under an extraRoots entry, outside locationPath', async () => {
      const target = path.join(outsideDir, 'attachment.txt');
      await fsPromises.writeFile(target, 'hi');

      const result = await resolveConfinedPath(target, locationPath, [outsideDir]);
      expect(result.ok).toBe(true);
    });

    it('rejects a path outside BOTH locationPath and every extraRoots entry', async () => {
      const thirdDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-third-'));
      try {
        const target = path.join(thirdDir, 'unrelated.txt');
        const result = await resolveConfinedPath(target, locationPath, [outsideDir]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
        }
      } finally {
        await fsPromises.rm(thirdDir, { recursive: true, force: true });
      }
    });

    it('does not crash and does not confine anything when an extraRoots entry does not exist on disk', async () => {
      const missingRoot = path.join(outsideDir, 'does-not-exist-root');
      const target = path.join(missingRoot, 'attachment.txt');

      const result = await resolveConfinedPath(target, locationPath, [missingRoot]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe(CONFINEMENT_REJECTED_MESSAGE);
      }
    });
  });
});

describe('isPathWithinRoots (#1571)', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attachment-root-'));
    outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attachment-outside-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
    await fsPromises.rm(outsideDir, { recursive: true, force: true });
  });

  it('resolves a path under one of the roots', async () => {
    const target = path.join(rootDir, 'attachment.png');
    await fsPromises.writeFile(target, 'hi');

    const result = await isPathWithinRoots(target, [rootDir]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolvedRoot = await fsPromises.realpath(rootDir);
      expect(result.resolvedPath.startsWith(resolvedRoot)).toBe(true);
    }
  });

  it('rejects a path outside all roots', async () => {
    const target = path.join(outsideDir, 'attachment.png');
    await fsPromises.writeFile(target, 'hi');

    const result = await isPathWithinRoots(target, [rootDir]);
    expect(result.ok).toBe(false);
  });

  it('resolves a path reaching a root via a symlink', async () => {
    const realTarget = path.join(rootDir, 'attachment.png');
    await fsPromises.writeFile(realTarget, 'hi');
    const linkPath = path.join(outsideDir, 'attachment-link.png');
    await fsPromises.symlink(realTarget, linkPath);

    const result = await isPathWithinRoots(linkPath, [rootDir]);
    expect(result.ok).toBe(true);
  });

  it('rejects everything when roots is empty', async () => {
    const target = path.join(rootDir, 'attachment.png');
    await fsPromises.writeFile(target, 'hi');

    const result = await isPathWithinRoots(target, []);
    expect(result.ok).toBe(false);
  });
});
