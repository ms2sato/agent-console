import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.bun-version` is the single source of the Bun version the repo is built and
// tested with. Everything else that names a Bun version must agree with it:
// the Dockerfiles' BUN_VERSION ARG, and every workflow's setup-bun step (which
// must read the file rather than carry its own literal).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pinned = read('.bun-version').trim();

describe('Bun version pins', () => {
  it('.bun-version is a plain x.y.z at or above the preinstall floor', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const floor = read('scripts/check-bun-version.mjs').match(/MIN_BUN_VERSION = "([^"]+)"/)?.[1];
    expect(floor).toBeDefined();
    expect(Bun.semver.order(pinned, floor)).toBeGreaterThanOrEqual(0);
  });

  it.each(['docker/Dockerfile', 'docker/Dockerfile.systemd'])(
    '%s BUN_VERSION default equals .bun-version',
    (file) => {
      expect(read(file).match(/^ARG BUN_VERSION=(\S+)$/m)?.[1]).toBe(pinned);
    },
  );

  it('docker/Dockerfile downloads no installer and asserts the version in every stage', () => {
    const text = read('docker/Dockerfile');
    expect(text).not.toMatch(/bun\.sh\/install/);
    expect(text.match(/test "\$\(bun --version\)" = "\$\{BUN_VERSION\}"/g)?.length).toBe(2);
  });

  it('every setup-bun step reads .bun-version and none carries a literal version', () => {
    const dir = join(ROOT, '.github', 'workflows');
    const offenders = [];
    let steps = 0;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      const uses = text.match(/uses: oven-sh\/setup-bun@/g)?.length ?? 0;
      steps += uses;
      const files = text.match(/^\s+bun-version-file: \.bun-version\s*$/gm)?.length ?? 0;
      if (files !== uses || /^\s+bun-version:/m.test(text)) offenders.push(name);
    }
    expect(steps).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  // setup-bun falls back to package.json (a range) when the version file
  // cannot be read, which would install the latest bun silently.
  it.skipIf(!process.env.GITHUB_ACTIONS)('the Bun running in CI is exactly .bun-version', () => {
    expect(Bun.version).toBe(pinned);
  });
});
