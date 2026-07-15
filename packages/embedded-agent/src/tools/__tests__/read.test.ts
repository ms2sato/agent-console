import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readTool, READ_MAX_BYTES } from '../read.js';

describe('readTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-read-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('reads a file with cat -n style 1-based line numbers', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'first\nsecond\nthird');

    const result = await readTool.execute({ path: 'a.txt' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe('1\tfirst\n2\tsecond\n3\tthird');
  });

  it('applies offset and limit', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'b.txt'), 'l1\nl2\nl3\nl4\nl5');

    const result = await readTool.execute({ path: 'b.txt', offset: 1, limit: 2 }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe('2\tl2\n3\tl3');
  });

  it('rejects a path outside locationPath with the verbatim confinement message', async () => {
    const result = await readTool.execute({ path: '/etc/passwd' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('returns a distinct failure shape for a nonexistent file (not the confinement message)', async () => {
    const result = await readTool.execute({ path: 'does-not-exist.txt' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^Failed to read file: /);
    expect(result.result).not.toBe('Access outside session location is not permitted.');
  });

  it('rejects a missing path argument', async () => {
    const result = await readTool.execute({}, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('path is required and must be a string');
  });

  it('rejects a non-numeric limit', async () => {
    const result = await readTool.execute({ path: 'a.txt', limit: 'lots' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('limit must be a number');
  });

  it('returns {ok:false, result:"aborted"} without reading the file when the signal is already aborted', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'first\nsecond');
    const controller = new AbortController();
    controller.abort();

    const result = await readTool.execute({ path: 'a.txt' }, { locationPath }, controller.signal);

    expect(result).toEqual({ ok: false, result: 'aborted' });
  });

  describe('byte cap', () => {
    it('reads a file exactly at the cap unchanged, with no truncation notice', async () => {
      const content = 'a'.repeat(READ_MAX_BYTES);
      await fsPromises.writeFile(path.join(locationPath, 'exact.txt'), content);

      const result = await readTool.execute({ path: 'exact.txt' }, { locationPath });

      expect(result.ok).toBe(true);
      expect(result.result).toBe(`1\t${content}`);
      expect(result.result).not.toContain('truncated');
    });

    it('truncates a file exactly 1 byte over the cap and appends a truncation notice', async () => {
      const content = 'a'.repeat(READ_MAX_BYTES + 1);
      await fsPromises.writeFile(path.join(locationPath, 'over-by-one.txt'), content);

      const result = await readTool.execute({ path: 'over-by-one.txt' }, { locationPath });

      expect(result.ok).toBe(true);
      expect(result.result).toContain(`1\t${'a'.repeat(READ_MAX_BYTES)}`);
      expect(result.result).toContain(
        `[Read truncated: file is ${READ_MAX_BYTES + 1} bytes, exceeding the ${READ_MAX_BYTES}-byte read cap.`,
      );
    });

    it('truncates a file well over the cap to the cap size, plus a truncation notice', async () => {
      const totalSize = READ_MAX_BYTES * 3;
      const content = 'b'.repeat(totalSize);
      await fsPromises.writeFile(path.join(locationPath, 'well-over.txt'), content);

      const result = await readTool.execute({ path: 'well-over.txt' }, { locationPath });

      expect(result.ok).toBe(true);
      const [body, ...rest] = result.result.split('\n\n[Read truncated');
      expect(body).toBe(`1\t${'b'.repeat(READ_MAX_BYTES)}`);
      expect(rest.join('')).toContain(`file is ${totalSize} bytes`);
    });

    it('never splits a multibyte character at the truncation boundary', async () => {
      // Fill up to one byte before the cap with ASCII, then place a 3-byte
      // multibyte character straddling the cap so the backoff logic must
      // drop the whole character rather than emit a partial/invalid tail.
      const asciiPrefix = 'a'.repeat(READ_MAX_BYTES - 1);
      const content = asciiPrefix + 'あ' + 'more content after the cap to push the file over the limit';
      await fsPromises.writeFile(path.join(locationPath, 'multibyte.txt'), content);

      const result = await readTool.execute({ path: 'multibyte.txt' }, { locationPath });

      expect(result.ok).toBe(true);
      expect(result.result).toContain('[Read truncated');
      expect(result.result).not.toContain('あ');
      expect(result.result).not.toContain('�');
    });
  });
});
