import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// docker/fetch-bun.sh is the only thing that puts a Bun binary into the Docker
// images. These tests run it for real against a local file:// "release server"
// so the property the images rely on -- a zip that does not hash to the
// repository's recorded SHA256 is never installed -- is exercised without the
// network. The zips are built with python3's zipfile (no `zip` binary needed).

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'fetch-bun.sh');
const VERSION = '9.9.9';

let work;
const dirs = { releases: '', out: '' };

function makeZip(zipPath, arch, content) {
  const py = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
info = zipfile.ZipInfo('bun-linux-' + sys.argv[2] + '/bun')
info.external_attr = 0o755 << 16
z.writestr(info, sys.argv[3])
z.close()`;
  const r = spawnSync('python3', ['-I', '-c', py, zipPath, arch, content], { encoding: 'utf8' });
  expect(r.status).toBe(0);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function run({ registry, out, arch = 'x86_64', baseUrl }) {
  return spawnSync('sh', [SCRIPT, registry, out], {
    encoding: 'utf8',
    env: { ...process.env, BUN_DOWNLOAD_BASE_URL: baseUrl ?? `file://${dirs.releases}`, BUN_FETCH_ARCH: arch },
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'fetch-bun-test-'));
  dirs.releases = join(work, 'releases');
  mkdirSync(join(dirs.releases, `bun-v${VERSION}`), { recursive: true });
  makeZip(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-x64.zip'), 'x64', '#!/bin/sh\necho x64-fixture\n');
  makeZip(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-aarch64.zip'), 'aarch64', '#!/bin/sh\necho aarch64-fixture\n');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const registryFile = (name, lines) => {
  const p = join(work, name);
  writeFileSync(p, ['# fixture registry', ...lines, ''].join('\n'));
  return p;
};
const freshOut = (name) => join(work, `out-${name}`);

describe('docker/fetch-bun.sh', () => {
  it('installs the binary and records the version when the zip hashes to the registry value', () => {
    const registry = registryFile('ok.txt', [
      `${VERSION} x64 ${sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-x64.zip'))}`,
      `${VERSION} aarch64 ${sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-aarch64.zip'))}`,
    ]);
    const out = freshOut('ok');
    const r = run({ registry, out });
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, 'bun-version'), 'utf8')).toBe(`${VERSION}\n`);
    expect(statSync(join(out, 'bun')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, 'bun'), 'utf8')).toContain('x64-fixture');
  });

  it('selects the entry for the running architecture', () => {
    const registry = registryFile('arch.txt', [
      `${VERSION} x64 ${'0'.repeat(64)}`,
      `${VERSION} aarch64 ${sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-aarch64.zip'))}`,
    ]);
    const out = freshOut('arch');
    const r = run({ registry, out, arch: 'aarch64' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, 'bun'), 'utf8')).toContain('aarch64-fixture');
  });

  it('refuses a zip that does not hash to the registry value and installs nothing', () => {
    const registry = registryFile('mismatch.txt', [
      `${VERSION} x64 ${'0'.repeat(64)}`,
      `${VERSION} aarch64 ${'0'.repeat(64)}`,
    ]);
    const out = freshOut('mismatch');
    const r = run({ registry, out });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SHA256 mismatch');
    expect(existsSync(join(out, 'bun'))).toBe(false);
    expect(existsSync(join(out, 'bun-version'))).toBe(false);
  });

  it('refuses a replaced release asset even though a checksum file next to it agrees with the new content', () => {
    // The recorded hash is of the genuine zip; the "server" now serves other bytes
    // AND a SHASUMS256.txt that matches them. Only the registry may decide.
    const genuine = sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-x64.zip'));
    const evilDir = join(work, 'evil');
    mkdirSync(join(evilDir, `bun-v${VERSION}`), { recursive: true });
    const evilZip = join(evilDir, `bun-v${VERSION}`, 'bun-linux-x64.zip');
    makeZip(evilZip, 'x64', '#!/bin/sh\necho tampered\n');
    writeFileSync(join(evilDir, `bun-v${VERSION}`, 'SHASUMS256.txt'), `${sha256(evilZip)}  bun-linux-x64.zip\n`);
    const registry = registryFile('evil.txt', [`${VERSION} x64 ${genuine}`]);
    const out = freshOut('evil');
    const r = run({ registry, out, baseUrl: `file://${evilDir}` });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(out, 'bun'))).toBe(false);
  });

  it('rejects a registry with two entries for the same version and architecture, even when the second one is genuine', () => {
    // `sha256sum -c` skips a malformed line with only a warning, so a bogus first
    // hash followed by the genuine one would otherwise be accepted.
    const genuine = sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-x64.zip'));
    const registry = registryFile('dup.txt', [`${VERSION} x64 ${'0'.repeat(64)}`, `${VERSION} x64 ${genuine}`]);
    const out = freshOut('dup');
    const r = run({ registry, out });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('duplicate entry');
    expect(existsSync(join(out, 'bun'))).toBe(false);
  });

  it('stops when the registry has no entry for the running architecture', () => {
    const registry = registryFile('noarch.txt', [`${VERSION} x64 ${'0'.repeat(64)}`]);
    const r = run({ registry, out: freshOut('noarch'), arch: 'aarch64' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no entry');
  });

  it('stops on an unsupported architecture', () => {
    const registry = registryFile('badarch.txt', [`${VERSION} x64 ${'0'.repeat(64)}`]);
    const r = run({ registry, out: freshOut('badarch'), arch: 'riscv64' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unsupported architecture');
  });

  it('stops when the registry names no version at all', () => {
    const registry = registryFile('empty.txt', []);
    const r = run({ registry, out: freshOut('empty') });
    expect(r.status).not.toBe(0);
  });

  it('stops when the download fails', () => {
    const registry = registryFile('dl.txt', [`${VERSION} x64 ${'0'.repeat(64)}`]);
    const out = freshOut('dl');
    const r = run({ registry, out, baseUrl: `file://${join(work, 'does-not-exist')}` });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(out, 'bun'))).toBe(false);
  });
});
