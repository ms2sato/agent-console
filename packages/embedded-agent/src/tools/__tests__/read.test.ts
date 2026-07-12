import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readTool } from '../read.js';

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
});
