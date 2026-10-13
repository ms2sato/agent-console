import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vol } from 'memfs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { canonicalPath } from '../canonical-path.js';

describe('canonicalPath', () => {
  beforeEach(() => {
    setupMemfs({
      '/real/repo/main/.keep': '',
      '/real/other/.keep': '',
    });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('resolves a symlinked directory to its target', async () => {
    vol.symlinkSync('/real', '/link');
    expect(await canonicalPath('/link/repo/main')).toBe('/real/repo/main');
  });

  it('returns a real path unchanged', async () => {
    expect(await canonicalPath('/real/repo/main')).toBe('/real/repo/main');
  });

  it('returns the resolved input unchanged for a nonexistent path, without throwing', async () => {
    expect(await canonicalPath('/does/not/exist')).toBe('/does/not/exist');
  });

  it('normalises a nonexistent path the way path.resolve does (dot segments, trailing slash)', async () => {
    expect(await canonicalPath('/does/./not/../not/exist/')).toBe('/does/not/exist');
  });

  it('resolves a relative input against the current working directory first', async () => {
    const cwd = process.cwd();
    // The relative form resolves to `<cwd>/rel/dir`; make that path a symlink to a real target.
    vol.mkdirSync(`${cwd}/rel`, { recursive: true });
    vol.symlinkSync('/real/other', `${cwd}/rel/dir`);
    expect(await canonicalPath('rel/dir')).toBe('/real/other');
  });

  it('follows a chain of two symlink hops to the final target', async () => {
    vol.symlinkSync('/real', '/hop2');
    vol.symlinkSync('/hop2', '/hop1');
    expect(await canonicalPath('/hop1/repo/main')).toBe('/real/repo/main');
  });

  it('treats a dangling symlink as its resolved self instead of throwing', async () => {
    vol.symlinkSync('/nowhere/at/all', '/dangling');
    expect(await canonicalPath('/dangling')).toBe('/dangling');
  });
});
