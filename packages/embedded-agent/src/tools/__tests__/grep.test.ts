import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { grepTool } from '../grep.js';

describe('grepTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-grep-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('defaults to files_with_matches output mode', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'hello world\nfoo bar');
    await fsPromises.writeFile(path.join(locationPath, 'b.txt'), 'no match here');

    const result = await grepTool.execute({ pattern: 'hello' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe(path.join(locationPath, 'a.txt'));
  });

  it('supports content output mode with file:line:content format', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'hello world\nfoo hello');

    const result = await grepTool.execute(
      { pattern: 'hello', outputMode: 'content' },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe(
      `${path.join(locationPath, 'a.txt')}:1:hello world\n${path.join(locationPath, 'a.txt')}:2:foo hello`,
    );
  });

  it('supports count output mode', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'hello\nhello\nworld');

    const result = await grepTool.execute({ pattern: 'hello', outputMode: 'count' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe(`${path.join(locationPath, 'a.txt')}:2`);
  });

  it('is case-insensitive when requested', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'HELLO world');

    const insensitive = await grepTool.execute(
      { pattern: 'hello', caseInsensitive: true },
      { locationPath },
    );
    expect(insensitive.result).toBe(path.join(locationPath, 'a.txt'));

    const sensitive = await grepTool.execute({ pattern: 'hello' }, { locationPath });
    expect(sensitive.result).toBe('');
  });

  it('filters by the glob argument', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.ts'), 'needle');
    await fsPromises.writeFile(path.join(locationPath, 'b.md'), 'needle');

    const result = await grepTool.execute({ pattern: 'needle', glob: '*.ts' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe(path.join(locationPath, 'a.ts'));
  });

  it('returns an empty successful result for zero matches (not an error)', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'a.txt'), 'nothing interesting');

    const result = await grepTool.execute({ pattern: 'needle' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe('');
  });

  it('skips binary files (NUL byte heuristic)', async () => {
    await fsPromises.writeFile(path.join(locationPath, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]));
    await fsPromises.writeFile(path.join(locationPath, 'text.txt'), 'hi there');

    const result = await grepTool.execute({ pattern: 'hi' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe(path.join(locationPath, 'text.txt'));
  });

  it('rejects an invalid regex pattern', async () => {
    const result = await grepTool.execute({ pattern: '(unterminated' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^Invalid regex pattern: /);
  });

  it('rejects a path argument outside locationPath', async () => {
    const result = await grepTool.execute({ pattern: 'x', path: '/etc' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('rejects a missing pattern argument', async () => {
    const result = await grepTool.execute({}, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('pattern is required and must be a string');
  });

  it('rejects a non-string path argument', async () => {
    const result = await grepTool.execute({ pattern: 'x', path: 42 }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('path must be a string');
  });

  it('rejects a non-string glob argument', async () => {
    const result = await grepTool.execute({ pattern: 'x', glob: 42 }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('glob must be a string');
  });

  it('rejects a non-boolean caseInsensitive argument', async () => {
    const result = await grepTool.execute({ pattern: 'x', caseInsensitive: 'yes' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('caseInsensitive must be a boolean');
  });

  it('rejects an invalid outputMode', async () => {
    const result = await grepTool.execute({ pattern: 'x', outputMode: 'bogus' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^outputMode must be one of/);
  });

  it('returns {ok:false, result:"aborted"} without completing the search when the signal is already aborted', async () => {
    for (let i = 0; i < 20; i++) {
      await fsPromises.writeFile(path.join(locationPath, `f${i}.txt`), 'needle');
    }
    const controller = new AbortController();
    controller.abort();

    const result = await grepTool.execute({ pattern: 'needle' }, { locationPath }, controller.signal);

    expect(result).toEqual({ ok: false, result: 'aborted' });
  });
});
