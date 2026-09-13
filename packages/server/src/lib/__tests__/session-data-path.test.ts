import { describe, it, expect } from 'bun:test';
import * as path from 'path';
import {
  computeSessionDataBaseDir,
  computeQuickCwdSlug,
  isValidSlug,
  InvalidSessionDataScopeError,
  type SessionDataScope,
} from '../session-data-path.js';

const CONFIG_DIR = '/test/config';

describe('computeSessionDataBaseDir', () => {
  describe('valid inputs', () => {
    it("returns '<configDir>/_quick' for quick scope with slug=null", () => {
      const result = computeSessionDataBaseDir(CONFIG_DIR, 'quick', null);
      expect(result).toBe(path.resolve(CONFIG_DIR, '_quick'));
    });

    it('returns repositories/<slug> for a simple slug', () => {
      const result = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo');
      expect(result).toBe(path.resolve(CONFIG_DIR, 'repositories', 'foo'));
    });

    it('returns nested path for org/repo slug', () => {
      const result = computeSessionDataBaseDir(
        CONFIG_DIR,
        'repository',
        'owner/repo-name'
      );
      expect(result).toBe(
        path.resolve(CONFIG_DIR, 'repositories', 'owner', 'repo-name')
      );
    });

    it('accepts slugs containing dots, underscores, and hyphens', () => {
      const result = computeSessionDataBaseDir(
        CONFIG_DIR,
        'repository',
        'my_repo.v2-beta'
      );
      expect(result).toBe(
        path.resolve(CONFIG_DIR, 'repositories', 'my_repo.v2-beta')
      );
    });

    it('accepts dots/underscores/hyphens on both sides of the org/repo slash', () => {
      const result = computeSessionDataBaseDir(
        CONFIG_DIR,
        'repository',
        'my-org.v2/sub_repo-1.2'
      );
      expect(result).toBe(
        path.resolve(CONFIG_DIR, 'repositories', 'my-org.v2', 'sub_repo-1.2')
      );
    });

    it('returns an absolute path for quick scope', () => {
      const result = computeSessionDataBaseDir(CONFIG_DIR, 'quick', null);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('returns an absolute path for repository scope', () => {
      const result = computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('returned path is always under configDir', () => {
      const quick = computeSessionDataBaseDir(CONFIG_DIR, 'quick', null);
      const repo = computeSessionDataBaseDir(
        CONFIG_DIR,
        'repository',
        'owner/repo'
      );
      const resolved = path.resolve(CONFIG_DIR);
      expect(quick.startsWith(resolved)).toBe(true);
      expect(repo.startsWith(resolved)).toBe(true);
    });

    it('resolves relative configDir into an absolute path', () => {
      const result = computeSessionDataBaseDir('./relative/config', 'quick', null);
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('adversarial inputs', () => {
    it("throws for scope='quick' with non-null slug", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'quick', 'anything')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for scope='quick' with empty-string slug", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'quick', '')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for scope='repository' with null slug", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', null)
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for scope='repository' with empty slug", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', '')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for slug with leading '../' (path traversal)", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', '../etc/passwd')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for slug with embedded '..' segment", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo/../bar')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it("throws for slug of just '..'", () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', '..')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for slug starting with absolute slash', () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', '/etc/passwd')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for slug with more than one slash', () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'a/b/c')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for slug with null byte', () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo\0bar')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for slug with space', () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo bar')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for slug with backslash', () => {
      expect(() =>
        computeSessionDataBaseDir(CONFIG_DIR, 'repository', 'foo\\bar')
      ).toThrow(InvalidSessionDataScopeError);
    });

    it('throws for unknown scope value (cast bypass)', () => {
      expect(() =>
        computeSessionDataBaseDir(
          CONFIG_DIR,
          'weird' as SessionDataScope,
          null
        )
      ).toThrow(InvalidSessionDataScopeError);
    });
  });
});

// Removing the hash-suffix branch of computeQuickCwdSlug (returning the
// sanitized basename alone) fails 'distinct for two different paths with the
// same basename' below -- measured.
describe('computeQuickCwdSlug', () => {
  it('has the shape <basename>-<12 hex chars>', () => {
    const slug = computeQuickCwdSlug('/home/user/my-project');
    expect(slug).toMatch(/^my-project-[0-9a-f]{12}$/);
  });

  it('produces a syntactically valid single-segment slug', () => {
    const slug = computeQuickCwdSlug('/home/user/my-project');
    expect(isValidSlug(slug)).toBe(true);
    expect(slug).not.toContain('/');
  });

  it('is distinct for /a/b vs /a-b (the SDK collision this design avoids)', () => {
    const slugAB = computeQuickCwdSlug('/a/b');
    const slugADashB = computeQuickCwdSlug('/a-b');
    expect(slugAB).not.toBe(slugADashB);
  });

  it('is distinct for two different paths with the same basename', () => {
    const slugX = computeQuickCwdSlug('/x/proj');
    const slugY = computeQuickCwdSlug('/y/proj');
    expect(slugX).not.toBe(slugY);
    // Both share the sanitized basename prefix; only the hash differs.
    expect(slugX.split('-')[0]).toBe('proj');
    expect(slugY.split('-')[0]).toBe('proj');
  });

  it('sanitizes a basename containing spaces and unicode', () => {
    const slug = computeQuickCwdSlug('/home/user/My Projéct 日本語');
    expect(slug).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("returns 'root-<hash>' for the filesystem root", () => {
    const slug = computeQuickCwdSlug('/');
    expect(slug).toMatch(/^root-[0-9a-f]{12}$/);
  });

  it('is deterministic (same input, same output)', () => {
    const a = computeQuickCwdSlug('/home/user/repeat-me');
    const b = computeQuickCwdSlug('/home/user/repeat-me');
    expect(a).toBe(b);
  });

  it('never produces "." or ".." as the full slug even for a dot-only basename', () => {
    const slugDot = computeQuickCwdSlug('/home/user/.');
    const slugDotDot = computeQuickCwdSlug('/home/user/..');
    expect(slugDot).not.toBe('.');
    expect(slugDotDot).not.toBe('..');
    expect(isValidSlug(slugDot)).toBe(true);
    expect(isValidSlug(slugDotDot)).toBe(true);
  });
});
