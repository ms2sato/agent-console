import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { editTool } from '../edit.js';

describe('editTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-edit-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('replaces a single match', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there' },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('1 replacement');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello there');
  });

  it('rejects when old_string has zero matches', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'nonexistent', new_string: 'x' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('not-found');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('rejects an ambiguous multi-match old_string when replace_all is not set', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'foo bar foo baz foo');

    const result = await editTool.execute(
      { file_path: target, old_string: 'foo', new_string: 'qux' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('ambiguous');
    expect(result.result).toContain('3');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('foo bar foo baz foo');
  });

  it('replaces every occurrence when replace_all is true', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'foo bar foo baz foo');

    const result = await editTool.execute(
      { file_path: target, old_string: 'foo', new_string: 'qux', replace_all: true },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('3 replacements');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('qux bar qux baz qux');
  });

  it('replace_all true with exactly one match still succeeds', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there', replace_all: true },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('1 replacement');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello there');
  });

  it('rejects a no-op edit where old_string === new_string', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'world' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('no-op');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('does not match when old_string differs only by whitespace (byte-exact matching)', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello  world'); // two spaces

    const result = await editTool.execute(
      { file_path: target, old_string: 'hello world', new_string: 'hi world' }, // one space
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('not-found');
  });

  it('rejects a path outside locationPath with the verbatim confinement message', async () => {
    const result = await editTool.execute(
      { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('rejects a missing file_path argument', async () => {
    const result = await editTool.execute({ old_string: 'a', new_string: 'b' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('file_path is required and must be a string');
  });

  it('rejects a missing old_string argument', async () => {
    const result = await editTool.execute({ file_path: 'a.txt', new_string: 'b' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('old_string is required and must be a string');
  });

  it('rejects a missing new_string argument', async () => {
    const result = await editTool.execute({ file_path: 'a.txt', old_string: 'a' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('new_string is required and must be a string');
  });

  it('rejects a non-boolean replace_all argument', async () => {
    const result = await editTool.execute(
      { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBe('replace_all must be a boolean');
  });

  it('rejects an empty old_string instead of hanging (regression: countOccurrences infinite loop)', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: '', new_string: 'x' },
      { locationPath },
    );

    expect(result).toEqual({ ok: false, result: 'old_string must not be empty' });
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('rejects a non-existent file with a distinct failure shape', async () => {
    const result = await editTool.execute(
      { file_path: 'does-not-exist.txt', old_string: 'a', new_string: 'b' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^Failed to read file: /);
  });

  it('formats a "Failed to write file" message when the write-back fails', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');
    // Read succeeds (file itself keeps its own permissions), but the directory
    // loses write permission, so atomicWrite's temp-file creation fails --
    // exercising the write-back catch branch distinct from the read-failure one.
    await fsPromises.chmod(locationPath, 0o555);

    try {
      const result = await editTool.execute(
        { file_path: target, old_string: 'world', new_string: 'there' },
        { locationPath },
      );

      expect(result.ok).toBe(false);
      expect(result.result).toMatch(/^Failed to write file: /);
    } finally {
      await fsPromises.chmod(locationPath, 0o755);
    }
  });

  it('returns {ok:false, result:"aborted"} without editing when the signal is already aborted', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');
    const controller = new AbortController();
    controller.abort();

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there' },
      { locationPath },
      controller.signal,
    );

    expect(result).toEqual({ ok: false, result: 'aborted' });
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });
});
