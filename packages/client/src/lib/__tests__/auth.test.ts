import { describe, it, expect, beforeEach } from 'bun:test';
import {
  getAuthMode,
  setAuthMode,
  getCurrentUser,
  setCurrentUser,
  isMultiUserMode,
  _reset,
} from '../auth';

describe('auth module', () => {
  beforeEach(() => {
    _reset();
  });

  describe('getAuthMode / setAuthMode', () => {
    it('should default to none', () => {
      expect(getAuthMode()).toBe('none');
    });

    it('should return the set auth mode', () => {
      setAuthMode('multi-user');
      expect(getAuthMode()).toBe('multi-user');
    });

    it('should allow switching back to none', () => {
      setAuthMode('multi-user');
      setAuthMode('none');
      expect(getAuthMode()).toBe('none');
    });
  });

  describe('getCurrentUser / setCurrentUser', () => {
    it('should default to null', () => {
      expect(getCurrentUser()).toBeNull();
    });

    it('should return the set user', () => {
      const user = { id: 'user-1', username: 'alice', homeDir: '/home/alice' };
      setCurrentUser(user);
      expect(getCurrentUser()).toEqual(user);
    });

    it('should allow clearing the user by setting null', () => {
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
      setCurrentUser(null);
      expect(getCurrentUser()).toBeNull();
    });
  });

  describe('isMultiUserMode', () => {
    it('should return false when auth mode is none', () => {
      expect(isMultiUserMode()).toBe(false);
    });

    it('should return true when auth mode is multi-user', () => {
      setAuthMode('multi-user');
      expect(isMultiUserMode()).toBe(true);
    });
  });

  describe('_reset', () => {
    it('should reset both auth mode and current user', () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

      _reset();

      expect(getAuthMode()).toBe('none');
      expect(getCurrentUser()).toBeNull();
    });
  });
});
