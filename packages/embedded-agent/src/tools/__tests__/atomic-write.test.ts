import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWrite } from '../atomic-write.js';

describe('atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-atomic-write-'));
  });

  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('writes content to a new file and returns the byte count written', async () => {
    const target = path.join(dir, 'a.txt');

    const { bytesWritten } = await atomicWrite(target, 'hello world');

    expect(bytesWritten).toBe(11);
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('reports the UTF-8 byte length, not the character length, for multi-byte content', async () => {
    const target = path.join(dir, 'multibyte.txt');
    const content = 'こんにちは';

    const { bytesWritten } = await atomicWrite(target, content);

    expect(bytesWritten).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(bytesWritten).not.toBe(content.length);
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe(content);
  });

  it('overwrites an existing file with byte-identical new content', async () => {
    const target = path.join(dir, 'existing.txt');
    await fsPromises.writeFile(target, 'old content that is much longer than the new content');

    const { bytesWritten } = await atomicWrite(target, 'new');

    expect(bytesWritten).toBe(3);
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('new');
  });

  it('leaves no stray temp file behind after a successful write', async () => {
    const target = path.join(dir, 'clean.txt');

    await atomicWrite(target, 'x');

    const entries = await fsPromises.readdir(dir);
    expect(entries).toEqual(['clean.txt']);
  });

  it('preserves the existing file mode (exec bit) across an overwrite', async () => {
    const target = path.join(dir, 'script.sh');
    await fsPromises.writeFile(target, '#!/bin/sh\necho old\n');
    await fsPromises.chmod(target, 0o755);

    await atomicWrite(target, '#!/bin/sh\necho new\n');

    const { mode } = await fsPromises.stat(target);
    expect(mode & 0o777).toBe(0o755);
  });

  it('applies the default umask mode (no mode to preserve) for a newly-created file', async () => {
    const target = path.join(dir, 'new-file.txt');
    const control = path.join(dir, 'control.txt');
    // Umask-dependent baseline: what Bun.write produces with no prior file at
    // the destination, established independently of atomicWrite's own logic.
    await Bun.write(control, 'baseline');
    const { mode: controlMode } = await fsPromises.stat(control);

    await atomicWrite(target, 'content');

    const { mode } = await fsPromises.stat(target);
    expect(mode & 0o777).toBe(controlMode & 0o777);
    expect(mode & 0o777).not.toBe(0o755);
  });

  it('cleans up the temp file and rethrows when the final rename fails', async () => {
    // Renaming a plain file onto an existing directory fails at the OS level
    // (EISDIR) -- this simulates the temp-write succeeding but the rename
    // step failing, exercising the best-effort cleanup path.
    const target = path.join(dir, 'blocked-target');
    await fsPromises.mkdir(target);

    await expect(atomicWrite(target, 'content')).rejects.toThrow();

    const entries = await fsPromises.readdir(dir);
    expect(entries).toEqual(['blocked-target']);
    expect(entries.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });
});
