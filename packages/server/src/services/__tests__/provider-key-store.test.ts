import { describe, it, expect, beforeEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProviderKey } from '../provider-key-store.js';

// NOTE: Fixture I/O uses native `Bun.write` / `Bun.file` (the same layer
// `loadProviderKey` reads through). Some sibling test files install a global
// `memfs` mock over `node:fs` which is process-wide in bun:test; using
// `node:fs` here would write to the in-memory FS while the production reader
// hits the real FS, causing a spurious miss in the full-suite run.

describe('loadProviderKey', () => {
  let keyFile: string;

  beforeEach(() => {
    keyFile = path.join(os.tmpdir(), `provider-keys-${crypto.randomUUID()}.json`);
  });

  it('resolves a present ref to its key (happy path)', async () => {
    await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test-123', ollama: 'x' }));
    const key = await loadProviderKey('openai', { filePath: keyFile });
    expect(key).toBe('sk-test-123');
  });

  it('throws naming the path and ref when the file is missing', async () => {
    const missing = path.join(os.tmpdir(), `absent-${crypto.randomUUID()}.json`);
    await expect(loadProviderKey('openai', { filePath: missing })).rejects.toThrow(missing);
    await expect(loadProviderKey('openai', { filePath: missing })).rejects.toThrow('openai');
  });

  it('throws a dangling-ref error when the ref is absent', async () => {
    await Bun.write(keyFile, JSON.stringify({ other: 'k' }));
    await expect(loadProviderKey('openai', { filePath: keyFile })).rejects.toThrow("'openai'");
  });

  it('throws when the ref value is an empty string', async () => {
    await Bun.write(keyFile, JSON.stringify({ openai: '' }));
    await expect(loadProviderKey('openai', { filePath: keyFile })).rejects.toThrow('non-empty string');
  });

  it('throws when the ref value is not a string', async () => {
    await Bun.write(keyFile, JSON.stringify({ openai: 123 }));
    await expect(loadProviderKey('openai', { filePath: keyFile })).rejects.toThrow('non-empty string');
  });

  it('throws a clear error on invalid JSON', async () => {
    await Bun.write(keyFile, '{ not valid json');
    await expect(loadProviderKey('openai', { filePath: keyFile })).rejects.toThrow('not valid JSON');
  });

  it('throws when the JSON root is not an object', async () => {
    await Bun.write(keyFile, JSON.stringify(['a', 'b']));
    await expect(loadProviderKey('openai', { filePath: keyFile })).rejects.toThrow('JSON object');
  });

  it('never includes the key value in a thrown message', async () => {
    await Bun.write(keyFile, JSON.stringify({ present: 'super-secret-value' }));
    let message = '';
    try {
      await loadProviderKey('absent', { filePath: keyFile });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('super-secret-value');
  });

  describe('file mode warning', () => {
    const makeSpyLogger = () => {
      const calls: Array<[Record<string, unknown>, string]> = [];
      return {
        logger: { warn: (obj: Record<string, unknown>, msg: string) => calls.push([obj, msg]) },
        calls,
      };
    };

    it('warns when the file mode is world/group readable (0644)', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '644', keyFile]).exited;
      const { logger: spyLogger, calls } = makeSpyLogger();

      await loadProviderKey('openai', { filePath: keyFile, logger: spyLogger });

      expect(calls).toHaveLength(1);
      const [context, message] = calls[0];
      expect(message).toContain('should be 0600');
      expect(context.filePath).toBe(keyFile);
      expect(message).not.toContain('sk-test');
    });

    it('warns when the file mode is group readable only (0640)', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '640', keyFile]).exited;
      const { logger: spyLogger, calls } = makeSpyLogger();

      await loadProviderKey('openai', { filePath: keyFile, logger: spyLogger });

      expect(calls).toHaveLength(1);
    });

    it('does not warn when the file mode is already 0600', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '600', keyFile]).exited;
      const { logger: spyLogger, calls } = makeSpyLogger();

      await loadProviderKey('openai', { filePath: keyFile, logger: spyLogger });

      expect(calls).toHaveLength(0);
    });

    it('does not fail activation when the mode is insecure', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '644', keyFile]).exited;

      const key = await loadProviderKey('openai', { filePath: keyFile });

      expect(key).toBe('sk-test');
    });
  });
});
