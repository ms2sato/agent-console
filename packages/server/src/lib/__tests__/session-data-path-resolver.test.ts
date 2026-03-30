import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';

const TEST_CONFIG_DIR = '/test/config';
const ORIGINAL_AGENT_CONSOLE_HOME = process.env.AGENT_CONSOLE_HOME;

describe('SessionDataPathResolver', () => {
  beforeEach(() => {
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_AGENT_CONSOLE_HOME === undefined) {
      delete process.env.AGENT_CONSOLE_HOME;
    } else {
      process.env.AGENT_CONSOLE_HOME = ORIGINAL_AGENT_CONSOLE_HOME;
    }
  });

  describe('with repositoryName', () => {
    it('should resolve messages dir under repository path', () => {
      const resolver = new SessionDataPathResolver('myorg/myrepo');
      expect(resolver.getMessagesDir()).toBe(`${TEST_CONFIG_DIR}/repositories/myorg/myrepo/messages`);
    });

    it('should resolve memos dir under repository path', () => {
      const resolver = new SessionDataPathResolver('myorg/myrepo');
      expect(resolver.getMemosDir()).toBe(`${TEST_CONFIG_DIR}/repositories/myorg/myrepo/memos`);
    });

    it('should resolve memos path with .md extension', () => {
      const resolver = new SessionDataPathResolver('myorg/myrepo');
      expect(resolver.getMemosPath('session-1')).toBe(
        `${TEST_CONFIG_DIR}/repositories/myorg/myrepo/memos/session-1.md`,
      );
    });

    it('should resolve outputs dir under repository path', () => {
      const resolver = new SessionDataPathResolver('myorg/myrepo');
      expect(resolver.getOutputsDir()).toBe(`${TEST_CONFIG_DIR}/repositories/myorg/myrepo/outputs`);
    });

    it('should resolve output file path with .log extension', () => {
      const resolver = new SessionDataPathResolver('myorg/myrepo');
      expect(resolver.getOutputFilePath('session-1', 'worker-1')).toBe(
        `${TEST_CONFIG_DIR}/repositories/myorg/myrepo/outputs/session-1/worker-1.log`,
      );
    });
  });

  describe('without repositoryName', () => {
    it('should resolve messages dir under _quick path', () => {
      const resolver = new SessionDataPathResolver();
      expect(resolver.getMessagesDir()).toBe(`${TEST_CONFIG_DIR}/_quick/messages`);
    });

    it('should resolve memos dir under _quick path', () => {
      const resolver = new SessionDataPathResolver();
      expect(resolver.getMemosDir()).toBe(`${TEST_CONFIG_DIR}/_quick/memos`);
    });

    it('should resolve memos path with .md extension under _quick', () => {
      const resolver = new SessionDataPathResolver();
      expect(resolver.getMemosPath('session-abc')).toBe(
        `${TEST_CONFIG_DIR}/_quick/memos/session-abc.md`,
      );
    });

    it('should resolve outputs dir under _quick path', () => {
      const resolver = new SessionDataPathResolver();
      expect(resolver.getOutputsDir()).toBe(`${TEST_CONFIG_DIR}/_quick/outputs`);
    });

    it('should resolve output file path under _quick', () => {
      const resolver = new SessionDataPathResolver();
      expect(resolver.getOutputFilePath('session-1', 'worker-1')).toBe(
        `${TEST_CONFIG_DIR}/_quick/outputs/session-1/worker-1.log`,
      );
    });
  });

  describe('with undefined repositoryName', () => {
    it('should behave the same as no argument', () => {
      const resolver = new SessionDataPathResolver(undefined);
      expect(resolver.getMessagesDir()).toBe(`${TEST_CONFIG_DIR}/_quick/messages`);
      expect(resolver.getOutputsDir()).toBe(`${TEST_CONFIG_DIR}/_quick/outputs`);
    });
  });
});
