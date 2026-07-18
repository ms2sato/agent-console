import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { globTool } from '../glob.js';

async function touch(file: string, delayMs = 0): Promise<void> {
  await fsPromises.writeFile(file, 'x');
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

describe('globTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-glob-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('matches files by pattern, sorted most-recently-modified first', async () => {
    await touch(path.join(locationPath, 'old.ts'), 50);
    await touch(path.join(locationPath, 'new.ts'));

    const result = await globTool.execute({ pattern: '*.ts' }, { locationPath });

    expect(result.ok).toBe(true);
    const lines = result.result.split('\n');
    expect(lines).toEqual([path.join(locationPath, 'new.ts'), path.join(locationPath, 'old.ts')]);
  });

  it('returns an empty successful result for zero matches (not an error)', async () => {
    const result = await globTool.execute({ pattern: '*.nope' }, { locationPath });

    expect(result.ok).toBe(true);
    expect(result.result).toBe('');
  });

  it('filters out matches that escape locationPath via a symlink', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-glob-outside-'));
    try {
      await touch(path.join(outsideDir, 'secret.ts'));
      await fsPromises.symlink(
        path.join(outsideDir, 'secret.ts'),
        path.join(locationPath, 'escape.ts'),
      );
      await touch(path.join(locationPath, 'inbound.ts'));

      const result = await globTool.execute({ pattern: '*.ts' }, { locationPath });

      expect(result.ok).toBe(true);
      expect(result.result).toBe(path.join(locationPath, 'inbound.ts'));
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a path argument outside locationPath', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: '/etc' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('rejects a missing pattern argument', async () => {
    const result = await globTool.execute({}, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('pattern is required and must be a string');
  });

  it('rejects a non-string path argument', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: 42 }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('path must be a string');
  });

  it('returns {ok:false, result:"aborted"} without completing the scan when the signal is already aborted', async () => {
    for (let i = 0; i < 20; i++) {
      await touch(path.join(locationPath, `f${i}.ts`));
    }
    const controller = new AbortController();
    controller.abort();

    const result = await globTool.execute({ pattern: '*.ts' }, { locationPath }, controller.signal);

    expect(result).toEqual({ ok: false, result: 'aborted' });
  });
});
