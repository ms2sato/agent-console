import { describe, it, expect, beforeEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadProviderKey,
  ProviderKeyStoreError,
  PROVIDER_KEY_STORE_UI_MESSAGES,
  type ProviderKeyStoreErrorKind,
} from '../provider-key-store.js';

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

  describe('ProviderKeyStoreError kind + ref (Issue #1259)', () => {
    it('kind=not-found, ref set, when the file is missing', async () => {
      const missing = path.join(os.tmpdir(), `absent-${crypto.randomUUID()}.json`);
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: missing });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      const err = caught as ProviderKeyStoreError;
      expect(err.kind).toBe('not-found');
      expect(err.ref).toBe('openai');
    });

    it('kind=unreadable when the file exists but cannot be read (permission denied)', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '000', keyFile]).exited;
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: keyFile });
      } catch (err) {
        caught = err;
      } finally {
        // Restore so any later cleanup / assertions on this fixture file don't fail.
        await Bun.spawn(['chmod', '600', keyFile]).exited;
      }
      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      expect((caught as ProviderKeyStoreError).kind).toBe('unreadable');
    });

    it('kind=invalid-json on unparseable content', async () => {
      await Bun.write(keyFile, '{ not valid json');
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: keyFile });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      expect((caught as ProviderKeyStoreError).kind).toBe('invalid-json');
    });

    it('kind=not-object when the JSON root is not an object', async () => {
      await Bun.write(keyFile, JSON.stringify(['a', 'b']));
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: keyFile });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      expect((caught as ProviderKeyStoreError).kind).toBe('not-object');
    });

    it('kind=missing-ref, ref set, when the ref is absent', async () => {
      await Bun.write(keyFile, JSON.stringify({ other: 'k' }));
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: keyFile });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderKeyStoreError);
      const err = caught as ProviderKeyStoreError;
      expect(err.kind).toBe('missing-ref');
      expect(err.ref).toBe('openai');
    });
  });

  describe('PROVIDER_KEY_STORE_UI_MESSAGES (Issue #1259)', () => {
    const ALL_KINDS = Object.keys(PROVIDER_KEY_STORE_UI_MESSAGES) as ProviderKeyStoreErrorKind[];

    it('covers exactly the 5 documented kinds', () => {
      const expectedKinds: ProviderKeyStoreErrorKind[] = [
        'invalid-json',
        'missing-ref',
        'not-found',
        'not-object',
        'unreadable',
      ];
      expect([...ALL_KINDS].sort()).toEqual(expectedKinds.sort());
    });

    it('every template names the file via the literal placeholder, never the real path', async () => {
      const sentinelRef = 'sentinel-ref-xyz';
      for (const kind of ALL_KINDS) {
        const message = PROVIDER_KEY_STORE_UI_MESSAGES[kind](sentinelRef);
        expect(message).toContain('<AGENT_CONSOLE_HOME>/provider-keys.json');
        expect(message).not.toContain(keyFile);
      }
    });

    it('never leaks a key-value-shaped sentinel or (for unreadable) fs error text, across all kinds', () => {
      const keySentinel = 'super-secret-key-value-sentinel';
      const fsErrorSentinel = 'ENOENT: fs-error-text-sentinel';
      for (const [kind, template] of Object.entries(PROVIDER_KEY_STORE_UI_MESSAGES) as [
        ProviderKeyStoreErrorKind,
        (ref: string) => string,
      ][]) {
        const message = template('some-ref');
        expect(message).not.toContain(keySentinel);
        if (kind === 'unreadable') {
          expect(message).not.toContain(fsErrorSentinel);
        }
      }
    });

    it('the unreadable message is a fixed sentence excluding the real fs error text end-to-end', async () => {
      await Bun.write(keyFile, JSON.stringify({ openai: 'sk-test' }));
      await Bun.spawn(['chmod', '000', keyFile]).exited;
      let caught: unknown;
      try {
        await loadProviderKey('openai', { filePath: keyFile });
      } catch (err) {
        caught = err;
      } finally {
        await Bun.spawn(['chmod', '600', keyFile]).exited;
      }
      const err = caught as ProviderKeyStoreError;
      expect(err.kind).toBe('unreadable');
      // The log-facing message DOES carry the real fs error text + path.
      expect(err.message).toContain(keyFile);
      // The UI-facing template does NOT.
      const uiMessage = PROVIDER_KEY_STORE_UI_MESSAGES[err.kind](err.ref);
      expect(uiMessage).not.toContain(keyFile);
      expect(uiMessage).not.toContain('EACCES');
      expect(uiMessage).not.toContain('permission denied');
    });
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
