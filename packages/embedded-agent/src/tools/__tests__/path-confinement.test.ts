import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveConfinedPath, CONFINEMENT_REJECTED_MESSAGE } from '../path-confinement.js';

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
});
