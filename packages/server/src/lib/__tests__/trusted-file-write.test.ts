import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { writeFileInTrustedDir } from '../trusted-file-write.js';

const ROOT = '/test/trusted-root';

describe('writeFileInTrustedDir', () => {
  beforeEach(() => {
    setupMemfs({ [`${ROOT}/.keep`]: '' });
  });
  afterEach(() => {
    cleanupMemfs();
  });

  it('creates the missing directories under the root and writes the content byte for byte, leaving no temp file', async () => {
    const target = `${ROOT}/a/b/file.md`;
    const content = 'one\r\ntwo  \n\nthree\n';
    await writeFileInTrustedDir(ROOT, target, content);
    expect(fs.readFileSync(target, 'utf-8')).toBe(content);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it('refuses a target outside the trusted root and writes nothing', async () => {
    await expect(writeFileInTrustedDir(ROOT, '/test/elsewhere/file.md', 'x')).rejects.toThrow();
    expect(fs.existsSync('/test/elsewhere/file.md')).toBe(false);
  });

  it('refuses a path whose ancestor is a regular file', async () => {
    fs.writeFileSync(`${ROOT}/blocker`, 'file');
    await expect(writeFileInTrustedDir(ROOT, `${ROOT}/blocker/file.md`, 'x')).rejects.toThrow();
  });
});
