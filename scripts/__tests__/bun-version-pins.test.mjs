import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two files decide which Bun the repo is built and tested with: the repo-root
// `.bun-version` (read by every workflow's setup-bun step) and
// `docker/bun-sha256.txt` (the version and release-zip SHA256 the Docker images
// install). Everything else that names a Bun version must agree with them.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pinned = read('.bun-version').trim();

const registryLines = read('docker/bun-sha256.txt')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => l.trim().split(/\s+/));

// The text of one Dockerfile stage, from its FROM line to the next FROM.
const stage = (text, name) => {
  const start = text.search(new RegExp(`^FROM .* AS ${name}$`, 'm'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.search(/^FROM /m);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('Bun version pins', () => {
  it('.bun-version is a plain x.y.z at or above the preinstall floor', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const floor = read('scripts/check-bun-version.mjs').match(/MIN_BUN_VERSION = "([^"]+)"/)?.[1];
    expect(floor).toBeDefined();
    expect(Bun.semver.order(pinned, floor)).toBeGreaterThanOrEqual(0);
  });

  it('docker/bun-sha256.txt lists exactly .bun-version, for x64 and aarch64, with a sha256 each', () => {
    expect(registryLines.map(([v, a]) => `${v} ${a}`).sort()).toEqual([`${pinned} aarch64`, `${pinned} x64`]);
    for (const [, , sha] of registryLines) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['docker/Dockerfile', 'docker/Dockerfile.systemd'])(
    '%s installs bun only through docker/fetch-bun.sh, from a dated Debian slim tag',
    (file) => {
      // Comments may explain what was replaced; only instructions count.
      const text = read(file)
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n');
      expect(text).not.toMatch(/bun\.sh\/install/);
      expect(text).not.toMatch(/oven\/bun/);
      expect(text).not.toMatch(/BUN_VERSION|BUN_BASE/);
      expect(text).toMatch(/^ARG DEBIAN_BASE=debian:trixie-\d{8}-slim$/m);
      expect(text).toMatch(/RUN sh \/tmp\/fetch-bun\.sh \/tmp\/bun-sha256\.txt \/out$/m);
    },
  );

  it('docker/Dockerfile asserts the version in the shared base and in the final stage, and leaves curl/unzip out of both', () => {
    const text = read('docker/Dockerfile');
    const assertion = /test "\$\(bun --version\)" = "\$\(cat \/usr\/local\/share\/bun-version\)"/;
    expect(stage(text, 'bun-base')).toMatch(assertion);
    expect(stage(text, 'runtime')).toMatch(assertion);
    // The final image is the last stage; it must be the one that is asserted.
    expect(text.trimEnd().split('\n').filter((l) => l.startsWith('FROM ')).pop()).toBe('FROM bun-base AS runtime');
    for (const name of ['bun-base', 'builder', 'runtime']) {
      expect(stage(text, name)).not.toMatch(/\b(curl|unzip)\b/);
    }
  });

  it('docker/Dockerfile.systemd asserts the installed version against the verified one', () => {
    expect(read('docker/Dockerfile.systemd')).toMatch(
      /test "\$\(\/usr\/local\/bin\/bun --version\)" = "\$\(cat \/usr\/local\/share\/bun-version\)"/,
    );
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
