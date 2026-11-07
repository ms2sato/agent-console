import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// docker/fetch-bun.sh is the only thing that puts a Bun binary into the Docker
// images. These tests run it for real against a local file:// "release server"
// so the property the images rely on -- a zip that does not hash to the
// repository's recorded SHA256 is never installed -- is exercised without the
// network. The fixture zips are written by makeZip below, so the tests need only
// what the script itself needs (sh, curl, unzip, awk, install) and no zip tool.

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'fetch-bun.sh');
const VERSION = '9.9.9';

let work;
const dirs = { releases: '', out: '' };

// A minimal single-entry ZIP (stored, no compression) holding `bun-linux-<arch>/bun`.
function makeZip(zipPath, arch, content) {
  const name = Buffer.from(`bun-linux-${arch}/bun`);
  const data = Buffer.from(content);
  const crc = Bun.hash.crc32(data);
  const common = (b, at) => {
    b.writeUInt16LE(20, at); // version needed
    b.writeUInt16LE(0, at + 2); // flags
    b.writeUInt16LE(0, at + 4); // method: stored
    b.writeUInt16LE(0, at + 6); // time
    b.writeUInt16LE(0x21, at + 8); // date: 1980-01-01
    b.writeUInt32LE(crc, at + 10);
    b.writeUInt32LE(data.length, at + 14); // compressed size
    b.writeUInt32LE(data.length, at + 18); // uncompressed size
    b.writeUInt16LE(name.length, at + 22);
    b.writeUInt16LE(0, at + 24); // extra length
  };
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  common(local, 4);
  const localPart = Buffer.concat([local, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  common(central, 6);
  central.writeUInt32LE(0, 42); // local header offset
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  writeFileSync(zipPath, Buffer.concat([localPart, centralPart, end]));
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function run({ registry, out, arch = 'x86_64', baseUrl, path }) {
  return spawnSync('/bin/sh', [SCRIPT, registry, out], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(path === undefined ? {} : { PATH: path }),
      BUN_DOWNLOAD_BASE_URL: baseUrl ?? `file://${dirs.releases}`,
      BUN_FETCH_ARCH: arch,
    },
  });
}

// A PATH holding only what the script needs, with NO `sha256sum` (the macOS
// shape), so the `shasum -a 256` branch is the one that runs. On a host that
// has sha256sum but no shasum, a tiny `shasum` forwards to it.
function pathWithoutSha256sum() {
  const bin = join(work, 'bin-no-sha256sum');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['awk', 'curl', 'unzip', 'mktemp', 'mkdir', 'install', 'rm']) {
    const found = Bun.which(tool);
    expect(found).not.toBeNull();
    symlinkSync(found, join(bin, tool));
  }
  const shasum = Bun.which('shasum');
  if (shasum) {
    symlinkSync(shasum, join(bin, 'shasum'));
  } else {
    writeFileSync(join(bin, 'shasum'), `#!/bin/sh\nshift 2\nexec ${Bun.which('sha256sum')} "$@"\n`);
    chmodSync(join(bin, 'shasum'), 0o755);
  }
  return bin;
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

  it('verifies through shasum when sha256sum does not exist, and still refuses a mismatch', () => {
    const path = pathWithoutSha256sum();
    const good = join(path, '..', 'good.txt');
    writeFileSync(good, `${VERSION} x64 ${sha256(join(dirs.releases, `bun-v${VERSION}`, 'bun-linux-x64.zip'))}\n`);
    const okOut = freshOut('shasum-ok');
    expect(run({ registry: good, out: okOut, path }).status).toBe(0);
    expect(existsSync(join(okOut, 'bun'))).toBe(true);

    const bad = registryFile('shasum-bad.txt', [`${VERSION} x64 ${'0'.repeat(64)}`]);
    const badOut = freshOut('shasum-bad');
    const r = run({ registry: bad, out: badOut, path });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SHA256 mismatch');
    expect(existsSync(join(badOut, 'bun'))).toBe(false);
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
