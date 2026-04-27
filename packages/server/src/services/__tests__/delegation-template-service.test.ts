import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vol } from 'memfs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { DelegationTemplateService } from '../delegation-template-service.js';
import { SessionDataPathResolver } from '../../lib/session-data-path-resolver.js';

const TEST_CONFIG_DIR = '/test/config';
const ORIGINAL_AGENT_CONSOLE_HOME = process.env.AGENT_CONSOLE_HOME;
const quickResolver = new SessionDataPathResolver(`${TEST_CONFIG_DIR}/_quick`);

const TEMPLATES_DIR = `${TEST_CONFIG_DIR}/_quick/delegation-templates`;
const fileFor = (sessionId: string) => `${TEMPLATES_DIR}/${sessionId}.json`;

describe('DelegationTemplateService', () => {
  let service: DelegationTemplateService;

  beforeEach(() => {
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    service = new DelegationTemplateService();
  });

  afterEach(() => {
    cleanupMemfs();
    if (ORIGINAL_AGENT_CONSOLE_HOME === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = ORIGINAL_AGENT_CONSOLE_HOME;
    }
  });

  describe('registerTemplate', () => {
    it('should create the directory and write the registry file', async () => {
      const filePath = await service.registerTemplate('session-1', 'callback', 'body-A', quickResolver);

      expect(filePath).toBe(fileFor('session-1'));
      expect(vol.existsSync(TEMPLATES_DIR)).toBe(true);

      const raw = vol.readFileSync(filePath, 'utf-8') as string;
      expect(JSON.parse(raw)).toEqual({ callback: 'body-A' });
    });

    it('should overwrite an existing name within the same session', async () => {
      await service.registerTemplate('session-1', 'callback', 'first', quickResolver);
      await service.registerTemplate('session-1', 'callback', 'second', quickResolver);

      const raw = vol.readFileSync(fileFor('session-1'), 'utf-8') as string;
      expect(JSON.parse(raw)).toEqual({ callback: 'second' });
    });

    it('should preserve other names when overwriting one', async () => {
      await service.registerTemplate('session-1', 'foo', 'F-old', quickResolver);
      await service.registerTemplate('session-1', 'bar', 'B', quickResolver);
      await service.registerTemplate('session-1', 'foo', 'F-new', quickResolver);

      const raw = vol.readFileSync(fileFor('session-1'), 'utf-8') as string;
      expect(JSON.parse(raw)).toEqual({ foo: 'F-new', bar: 'B' });
    });

    it('should reject content exceeding 256KB', async () => {
      const oversized = 'x'.repeat(256 * 1024 + 1);
      await expect(
        service.registerTemplate('session-1', 'big', oversized, quickResolver),
      ).rejects.toThrow(/exceeds maximum size/);
    });

    it('should reject sessionId with path traversal (..)', async () => {
      await expect(
        service.registerTemplate('../etc/passwd', 'name', 'body', quickResolver),
      ).rejects.toThrow(/Invalid sessionId/);
    });

    it('should reject sessionId with slashes', async () => {
      await expect(
        service.registerTemplate('foo/bar', 'name', 'body', quickResolver),
      ).rejects.toThrow(/Invalid sessionId/);
    });

    it('should reject invalid template names', async () => {
      await expect(
        service.registerTemplate('session-1', 'has space', 'body', quickResolver),
      ).rejects.toThrow(/Invalid template name/);
      await expect(
        service.registerTemplate('session-1', '../etc', 'body', quickResolver),
      ).rejects.toThrow(/Invalid template name/);
      await expect(
        service.registerTemplate('session-1', '', 'body', quickResolver),
      ).rejects.toThrow(/Invalid template name/);
      const longName = 'a'.repeat(65);
      await expect(
        service.registerTemplate('session-1', longName, 'body', quickResolver),
      ).rejects.toThrow(/Invalid template name/);
    });

    it('should accept names with hyphens, underscores, and digits', async () => {
      await service.registerTemplate('session-1', 'retro-callback_2', 'body', quickResolver);
      const raw = vol.readFileSync(fileFor('session-1'), 'utf-8') as string;
      expect(JSON.parse(raw)).toEqual({ 'retro-callback_2': 'body' });
    });
  });

  describe('listTemplates', () => {
    it('should return an empty array when no file exists', async () => {
      const list = await service.listTemplates('session-x', quickResolver);
      expect(list).toEqual([]);
    });

    it('should return a single registered template', async () => {
      await service.registerTemplate('session-1', 'foo', 'F', quickResolver);

      const list = await service.listTemplates('session-1', quickResolver);
      expect(list).toEqual([{ name: 'foo', content: 'F' }]);
    });

    it('should return multiple templates sorted by name', async () => {
      await service.registerTemplate('session-1', 'zeta', 'Z', quickResolver);
      await service.registerTemplate('session-1', 'alpha', 'A', quickResolver);
      await service.registerTemplate('session-1', 'mike', 'M', quickResolver);

      const list = await service.listTemplates('session-1', quickResolver);
      expect(list).toEqual([
        { name: 'alpha', content: 'A' },
        { name: 'mike', content: 'M' },
        { name: 'zeta', content: 'Z' },
      ]);
    });
  });

  describe('deleteTemplate', () => {
    it('should remove the named entry and leave others intact', async () => {
      await service.registerTemplate('session-1', 'a', 'A', quickResolver);
      await service.registerTemplate('session-1', 'b', 'B', quickResolver);

      const result = await service.deleteTemplate('session-1', 'a', quickResolver);
      expect(result).toEqual({ deleted: true });

      const list = await service.listTemplates('session-1', quickResolver);
      expect(list).toEqual([{ name: 'b', content: 'B' }]);
    });

    it('should be idempotent when name does not exist (returns deleted=false, no throw)', async () => {
      await service.registerTemplate('session-1', 'a', 'A', quickResolver);

      const result = await service.deleteTemplate('session-1', 'missing', quickResolver);
      expect(result).toEqual({ deleted: false });

      // Other entries remain intact
      const list = await service.listTemplates('session-1', quickResolver);
      expect(list).toEqual([{ name: 'a', content: 'A' }]);
    });

    it('should leave an empty {} file when last template is deleted', async () => {
      await service.registerTemplate('session-1', 'only', 'X', quickResolver);
      const result = await service.deleteTemplate('session-1', 'only', quickResolver);

      expect(result).toEqual({ deleted: true });
      // File still exists with an empty object — atomicity simplicity, no special-case
      const raw = vol.readFileSync(fileFor('session-1'), 'utf-8') as string;
      expect(JSON.parse(raw)).toEqual({});
      const list = await service.listTemplates('session-1', quickResolver);
      expect(list).toEqual([]);
    });

    it('should be a no-op (deleted=false) when no registry file exists', async () => {
      const result = await service.deleteTemplate('session-x', 'anything', quickResolver);
      expect(result).toEqual({ deleted: false });
    });
  });

  describe('lookupTemplates', () => {
    it('should return empty arrays for empty names input (no-op boundary)', async () => {
      await service.registerTemplate('session-1', 'a', 'A', quickResolver);

      const result = await service.lookupTemplates('session-1', [], quickResolver);
      expect(result).toEqual({ found: [], missing: [] });
    });

    it('should return a single found template', async () => {
      await service.registerTemplate('session-1', 'a', 'AAA', quickResolver);

      const result = await service.lookupTemplates('session-1', ['a'], quickResolver);
      expect(result).toEqual({ found: [{ name: 'a', content: 'AAA' }], missing: [] });
    });

    it('should report a single missing name', async () => {
      const result = await service.lookupTemplates('session-1', ['nope'], quickResolver);
      expect(result).toEqual({ found: [], missing: ['nope'] });
    });

    it('should return found and missing arrays for mixed input', async () => {
      await service.registerTemplate('session-1', 'a', 'AAA', quickResolver);
      await service.registerTemplate('session-1', 'b', 'BBB', quickResolver);

      const result = await service.lookupTemplates('session-1', ['a', 'missing', 'b'], quickResolver);
      expect(result).toEqual({
        found: [
          { name: 'a', content: 'AAA' },
          { name: 'b', content: 'BBB' },
        ],
        missing: ['missing'],
      });
    });

    it('should preserve input order in the found array', async () => {
      await service.registerTemplate('session-1', 'a', 'AAA', quickResolver);
      await service.registerTemplate('session-1', 'b', 'BBB', quickResolver);
      await service.registerTemplate('session-1', 'c', 'CCC', quickResolver);

      const result = await service.lookupTemplates('session-1', ['c', 'a', 'b'], quickResolver);
      expect(result.found.map((t) => t.name)).toEqual(['c', 'a', 'b']);
      expect(result.missing).toEqual([]);
    });
  });

  describe('deleteAllForSession', () => {
    it('should remove the per-session registry file', async () => {
      await service.registerTemplate('session-1', 'a', 'A', quickResolver);
      expect(vol.existsSync(fileFor('session-1'))).toBe(true);

      await service.deleteAllForSession('session-1', quickResolver);
      expect(vol.existsSync(fileFor('session-1'))).toBe(false);
    });

    it('should be a no-op when the file does not exist', async () => {
      // Ensure parent dir exists so rm doesn't fail on missing parent
      vol.mkdirSync(TEMPLATES_DIR, { recursive: true });

      await expect(
        service.deleteAllForSession('nonexistent', quickResolver),
      ).resolves.toBeUndefined();
    });
  });

  describe('cross-session isolation', () => {
    it('should not surface session A templates when listing session B', async () => {
      await service.registerTemplate('session-A', 'foo', 'A-foo', quickResolver);

      const list = await service.listTemplates('session-B', quickResolver);
      expect(list).toEqual([]);
    });

    it('should not surface session A templates when looking up via session B', async () => {
      await service.registerTemplate('session-A', 'foo', 'A-foo', quickResolver);

      const result = await service.lookupTemplates('session-B', ['foo'], quickResolver);
      expect(result).toEqual({ found: [], missing: ['foo'] });
    });
  });
});
