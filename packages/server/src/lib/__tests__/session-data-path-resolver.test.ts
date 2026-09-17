import { describe, it, expect } from 'bun:test';
import { SessionDataPathResolver } from '../session-data-path-resolver.js';
import { computeQuickCwdSlug, InvalidSessionDataScopeError } from '../session-data-path.js';

/**
 * After Stage 2, `SessionDataPathResolver` is a thin wrapper over a
 * precomputed baseDir. These tests verify it just joins the well-known
 * subdirectories under that base — nothing more.
 *
 * Scope/slug validation lives in `computeSessionDataBaseDir` (see its tests).
 */
// The trusted root every path is verified against on the inode chain
// (`ensureTrustedDirChain`); production passes the same `configDir` the base
// was computed from, so the fixture does the same.
const TRUSTED_ROOT = '/test/config';

describe('SessionDataPathResolver', () => {
  const BASE_DIR = '/test/config/repositories/myorg/myrepo';

  it('resolves messages dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getMessagesDir()).toBe(`${BASE_DIR}/messages`);
  });

  it('resolves memos dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getMemosDir()).toBe(`${BASE_DIR}/memos`);
  });

  it('resolves memos path with .md extension', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getMemosPath('session-1')).toBe(`${BASE_DIR}/memos/session-1.md`);
  });

  it('resolves outputs dir under baseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getOutputsDir()).toBe(`${BASE_DIR}/outputs`);
  });

  it('resolves output file path with .log extension', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getOutputFilePath('session-1', 'worker-1')).toBe(
      `${BASE_DIR}/outputs/session-1/worker-1.log`,
    );
  });

  it('works for quick-session-style baseDirs', () => {
    const quickBase = '/test/config/_quick';
    const resolver = new SessionDataPathResolver(quickBase, TRUSTED_ROOT);
    expect(resolver.getOutputsDir()).toBe(`${quickBase}/outputs`);
  });

  // Memory layer (epic #1636 Phase 2, CodeRabbit MAJOR fix): `getBaseDir`
  // is exposed only so `ensureMemoryDir` can walk from the trusted base.
  it('exposes the constructor baseDir via getBaseDir', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getBaseDir()).toBe(BASE_DIR);
  });

  // Trusted-root walker (docs/design/session-data-path.md section 2): the
  // root is a REQUIRED constructor argument with no ambient fallback, and
  // `getTrustedRoot` returns exactly what was passed -- never a value derived
  // from `baseDir` or read from the environment. Measured: returning
  // `path.dirname(this.baseDir)` instead fails this pin (`/test/config/
  // repositories/myorg` !== `/test/config`), as does returning a constant.
  it('exposes the constructor trustedRoot via getTrustedRoot, unchanged', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getTrustedRoot()).toBe(TRUSTED_ROOT);
    const other = new SessionDataPathResolver(BASE_DIR, '/elsewhere/root');
    expect(other.getTrustedRoot()).toBe('/elsewhere/root');
  });
});

// Memory layer (epic #1636 Phase 2). Removing the `scope.kind === 'quick'`
// branch (always returning the repository-shaped path) fails the
// 'quick scope' test below -- measured.
describe('SessionDataPathResolver.getMemoryDir', () => {
  const BASE_DIR = '/test/config/repositories/myorg/myrepo';

  it('resolves the repository-scoped memory path', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(resolver.getMemoryDir('def-1', { kind: 'repository' })).toBe(
      `${BASE_DIR}/memory/def-1`,
    );
  });

  it('resolves the quick-scoped memory path (with cwd-slug)', () => {
    const quickBase = '/test/config/_quick';
    const resolver = new SessionDataPathResolver(quickBase, TRUSTED_ROOT);
    const cwdSlug = computeQuickCwdSlug('/home/user/project');
    expect(resolver.getMemoryDir('def-1', { kind: 'quick', cwdSlug })).toBe(
      `${quickBase}/memory/def-1/${cwdSlug}`,
    );
  });

  it('accepts a real computeQuickCwdSlug output for the quick scope', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    const cwdSlug = computeQuickCwdSlug('/a/b');
    expect(() => resolver.getMemoryDir('def-1', { kind: 'quick', cwdSlug })).not.toThrow();
  });

  it('throws when definitionId contains a slash', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(() => resolver.getMemoryDir('def/1', { kind: 'repository' })).toThrow(
      InvalidSessionDataScopeError,
    );
  });

  it('throws when definitionId is ".."', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(() => resolver.getMemoryDir('..', { kind: 'repository' })).toThrow(
      InvalidSessionDataScopeError,
    );
  });

  it('throws when cwdSlug (quick scope) contains a slash', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    expect(() =>
      resolver.getMemoryDir('def-1', { kind: 'quick', cwdSlug: 'a/b' }),
    ).toThrow(InvalidSessionDataScopeError);
  });

  // Issue #1709: `getMemoryDir` validates via `assertValidSegment` imported
  // from `session-data-path.js` -- the SHARED single writer of the segment
  // grammar, not a private copy in this file. Pinning the exact error
  // message (not just the error class, already covered above) is what
  // catches a future re-fork: reintroducing a private
  // `assertValidSegment`/`SEGMENT_PATTERN` copy in the resolver with even a
  // slightly different message text (e.g. dropping the quoted value, or
  // rewording "is not a valid single path segment") fails this assertion
  // while the class-only checks above would stay green. Mutation measured:
  // a local copy of `assertValidSegment` in this file that throws
  // `InvalidSessionDataScopeError('bad definitionId')` instead of the
  // shared writer's message fails this test.
  it('rejects a multi-segment definitionId with the shared writer\'s exact message', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    let caught: unknown;
    try {
      resolver.getMemoryDir('a/b', { kind: 'repository' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidSessionDataScopeError);
    expect((caught as Error).message).toBe('definitionId "a/b" is not a valid single path segment');
  });

  it('rejects a dot definitionId with the shared writer\'s exact message', () => {
    const resolver = new SessionDataPathResolver(BASE_DIR, TRUSTED_ROOT);
    let caught: unknown;
    try {
      resolver.getMemoryDir('.', { kind: 'repository' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidSessionDataScopeError);
    expect((caught as Error).message).toBe('definitionId "." is not a valid single path segment');
  });
});
