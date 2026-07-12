import { describe, it, expect } from 'bun:test';
import { canManageEmbeddedAgent } from '../canManageEmbeddedAgent';

describe('canManageEmbeddedAgent', () => {
  describe('single-user mode (isMultiUser: false)', () => {
    it('returns true even when currentUser is null (the default: main.tsx never populates it in single-user mode)', () => {
      expect(canManageEmbeddedAgent('creator-1', null, false)).toBe(true);
    });

    it('returns true even when currentUser.id does not match createdBy', () => {
      expect(canManageEmbeddedAgent('creator-1', 'someone-else', false)).toBe(true);
    });

    it('returns true when currentUser.id matches createdBy', () => {
      expect(canManageEmbeddedAgent('creator-1', 'creator-1', false)).toBe(true);
    });
  });

  describe('multi-user mode (isMultiUser: true)', () => {
    it('returns true when currentUser.id matches createdBy', () => {
      expect(canManageEmbeddedAgent('creator-1', 'creator-1', true)).toBe(true);
    });

    it('returns false when currentUser.id does not match createdBy', () => {
      expect(canManageEmbeddedAgent('creator-1', 'someone-else', true)).toBe(false);
    });

    it('returns false when currentUser is null', () => {
      expect(canManageEmbeddedAgent('creator-1', null, true)).toBe(false);
    });

    it('returns false when currentUser is undefined', () => {
      expect(canManageEmbeddedAgent('creator-1', undefined, true)).toBe(false);
    });
  });
});
