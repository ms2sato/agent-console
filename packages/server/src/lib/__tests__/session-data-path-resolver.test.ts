import { describe, it, expect } from 'bun:test';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';

/**
 * After Stage 2, `SessionDataPathResolver` is a thin wrapper over a
 * precomputed baseDir. These tests verify it just joins the well-known
 * subdirectories under that base — nothing more.
 *
 * Scope/slug validation lives in `computeSessionDataBaseDir` (see its tests).
 */
describe('SessionDataPathResolver', () => {
  const BASE_DIR = '/test/config/repositories/myorg/myrepo';

  it('resolves messages dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR);
    expect(resolver.getMessagesDir()).toBe(`${BASE_DIR}/messages`);
  });

  it('resolves memos dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR);
    expect(resolver.getMemosDir()).toBe(`${BASE_DIR}/memos`);
  });

  it('resolves memos path with .md extension', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR);
    expect(resolver.getMemosPath('session-1')).toBe(`${BASE_DIR}/memos/session-1.md`);
  });

  it('resolves outputs dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR);
    expect(resolver.getOutputsDir()).toBe(`${BASE_DIR}/outputs`);
  });

  it('resolves output file path with .log extension', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR);
    expect(resolver.getOutputFilePath('session-1', 'worker-1')).toBe(
      `${BASE_DIR}/outputs/session-1/worker-1.log`,
    );
  });

  it('works for quick-session-style baseDirs', () => {
    const quickBase = '/test/config/_quick';
    const resolver = new SessionDataPathResolver(quickBase);
    expect(resolver.getOutputsDir()).toBe(`${quickBase}/outputs`);
  });
});
