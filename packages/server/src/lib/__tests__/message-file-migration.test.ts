import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vol } from 'memfs';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { renameLegacyMessageFiles } from '../message-file-migration.js';

const CONFIG = '/test/config';
const LEGACY = '1700000000000-sender-session-0123abcd.json';
const CONVERTED = '1700000000000-sender-session-0123abcd.md';

function workerDir(base: string): string {
  return `${base}/messages/s1/w1`;
}

describe('renameLegacyMessageFiles', () => {
  beforeEach(() => {
    setupMemfs({ [`${CONFIG}/.keep`]: '' });
  });

  afterEach(() => {
    cleanupMemfs();
  });

  it('renames one legacy file in each of the three base-dir shapes', async () => {
    const bases = [`${CONFIG}/_quick`, `${CONFIG}/repositories/a`, `${CONFIG}/repositories/a/b`];
    for (const base of bases) {
      vol.mkdirSync(workerDir(base), { recursive: true });
      vol.writeFileSync(`${workerDir(base)}/${LEGACY}`, 'hello\nnot json');
    }

    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 3, skipped: 0 });

    for (const base of bases) {
      expect(vol.readdirSync(workerDir(base))).toEqual([CONVERTED]);
      expect(vol.readFileSync(`${workerDir(base)}/${CONVERTED}`, 'utf-8')).toBe('hello\nnot json');
    }
  });

  it('is idempotent: a second run renames and skips nothing', async () => {
    vol.mkdirSync(workerDir(`${CONFIG}/_quick`), { recursive: true });
    vol.writeFileSync(`${workerDir(`${CONFIG}/_quick`)}/${LEGACY}`, 'x');

    expect((await renameLegacyMessageFiles(CONFIG)).renamed).toBe(1);
    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 0, skipped: 0 });
  });

  it('leaves .tmp- files and non-matching names untouched', async () => {
    const dir = workerDir(`${CONFIG}/_quick`);
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(`${dir}/.tmp-1700000000000-sender-0123abcd.json`, 'x');
    vol.writeFileSync(`${dir}/notes.json`, 'x');

    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 0, skipped: 0 });
    expect(vol.readdirSync(dir).sort()).toEqual(['.tmp-1700000000000-sender-0123abcd.json', 'notes.json']);
  });

  it('does not rename a symlink named like a legacy file', async () => {
    const dir = workerDir(`${CONFIG}/_quick`);
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(`${CONFIG}/elsewhere.txt`, 'x');
    vol.symlinkSync(`${CONFIG}/elsewhere.txt`, `${dir}/${LEGACY}`);

    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 0, skipped: 0 });
    expect(fs.lstatSync(`${dir}/${LEGACY}`).isSymbolicLink()).toBe(true);
    expect(vol.existsSync(`${dir}/${CONVERTED}`)).toBe(false);
  });

  it('keeps the .json file and counts a skip when the .md target already exists', async () => {
    const dir = workerDir(`${CONFIG}/_quick`);
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(`${dir}/${LEGACY}`, 'legacy');
    vol.writeFileSync(`${dir}/${CONVERTED}`, 'current');

    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 0, skipped: 1 });
    expect(vol.readFileSync(`${dir}/${LEGACY}`, 'utf-8')).toBe('legacy');
    expect(vol.readFileSync(`${dir}/${CONVERTED}`, 'utf-8')).toBe('current');
  });

  it('returns zero counts without throwing when no data directories exist', async () => {
    expect(await renameLegacyMessageFiles(CONFIG)).toEqual({ renamed: 0, skipped: 0 });
  });
});
