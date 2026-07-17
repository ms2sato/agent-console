import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeTool } from '../write.js';

describe('writeTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-write-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('creates a new file and reports it as created', async () => {
    const target = path.join(locationPath, 'new-file.txt');

    const result = await writeTool.execute({ file_path: target, content: 'hello world' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toContain('File created');
    expect(result.result).toContain('11 bytes');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('overwrites an existing file with byte-identical content and reports it as overwritten', async () => {
    const target = path.join(locationPath, 'existing.txt');
    await fsPromises.writeFile(target, 'old content');

    const result = await writeTool.execute({ file_path: target, content: 'new content!' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toContain('File overwritten');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('new content!');
  });

  it('rejects a path outside locationPath with the verbatim confinement message', async () => {
    const result = await writeTool.execute(
      { file_path: '/etc/passwd', content: 'nope' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('rejects a missing file_path argument', async () => {
    const result = await writeTool.execute({ content: 'x' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('file_path is required and must be a string');
  });

  it('rejects a missing content argument', async () => {
    const result = await writeTool.execute({ file_path: 'a.txt' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('content is required and must be a string');
  });

  it('rejects a non-string content argument', async () => {
    const result = await writeTool.execute({ file_path: 'a.txt', content: 42 }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('content is required and must be a string');
  });

  it('formats a "Failed to write file" message when atomicWrite fails', async () => {
    // A directory already exists at the target path, so atomicWrite's final
    // rename fails with EISDIR -- exercising the write tool's catch branch
    // that formats atomicWrite's rejection into a result message.
    const target = path.join(locationPath, 'blocked-dir');
    await fsPromises.mkdir(target);

    const result = await writeTool.execute({ file_path: target, content: 'new content' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^Failed to write file: /);
  });

  it('leaves no stray temp file behind after a successful write (atomic write verification)', async () => {
    const target = path.join(locationPath, 'atomic.txt');

    const result = await writeTool.execute({ file_path: target, content: 'atomic content' }, { locationPath });

    expect(result.ok).toBe(true);
    const entries = await fsPromises.readdir(locationPath);
    expect(entries).toEqual(['atomic.txt']);
    expect(entries.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('returns {ok:false, result:"aborted"} without writing when the signal is already aborted', async () => {
    const target = path.join(locationPath, 'aborted.txt');
    const controller = new AbortController();
    controller.abort();

    const result = await writeTool.execute({ file_path: target, content: 'x' }, { locationPath }, controller.signal);

    expect(result).toEqual({ ok: false, result: 'aborted' });
    await expect(fsPromises.stat(target)).rejects.toThrow();
  });
});
