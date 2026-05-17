import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  getAuthMode,
  setAuthMode,
  getCurrentUser,
  setCurrentUser,
  getSharedAccountsAvailable,
  setSharedAccountsAvailable,
  isMultiUserMode,
  subscribeAuth,
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

  describe('getSharedAccountsAvailable / setSharedAccountsAvailable', () => {
    it('should default to false', () => {
      expect(getSharedAccountsAvailable()).toBe(false);
    });

    it('should return the set value', () => {
      setSharedAccountsAvailable(true);
      expect(getSharedAccountsAvailable()).toBe(true);
    });

    it('should allow toggling back to false', () => {
      setSharedAccountsAvailable(true);
      setSharedAccountsAvailable(false);
      expect(getSharedAccountsAvailable()).toBe(false);
    });

    it('should notify listeners when changed', () => {
      const listener = mock(() => {});
      subscribeAuth(listener);

      setSharedAccountsAvailable(true);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeAuth', () => {
    it('should notify listener when setAuthMode is called', () => {
      const listener = mock(() => {});
      subscribeAuth(listener);

      setAuthMode('multi-user');

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify listener when setCurrentUser is called', () => {
      const listener = mock(() => {});
      subscribeAuth(listener);

      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should not notify after unsubscribing', () => {
      const listener = mock(() => {});
      const unsubscribe = subscribeAuth(listener);

      unsubscribe();
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

      expect(listener).toHaveBeenCalledTimes(0);
    });
  });

  describe('_reset', () => {
    it('should reset auth mode, current user, and shared accounts availability', () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });
      setSharedAccountsAvailable(true);

      _reset();

      expect(getAuthMode()).toBe('none');
      expect(getCurrentUser()).toBeNull();
      expect(getSharedAccountsAvailable()).toBe(false);
    });
  });
});
