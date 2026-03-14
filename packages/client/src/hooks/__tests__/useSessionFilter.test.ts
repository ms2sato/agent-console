import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useSessionFilter, clearStoredFilterMode, STORAGE_KEY } from '../useSessionFilter';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../lib/auth';

describe('useSessionFilter', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuth();
  });

  describe('filterMode', () => {
    it('should default to all', () => {
      const { result } = renderHook(() => useSessionFilter());
      expect(result.current.filterMode).toBe('all');
    });

    it('should read from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, 'mine');
      const { result } = renderHook(() => useSessionFilter());
      expect(result.current.filterMode).toBe('mine');
    });

    it('should ignore invalid localStorage values', () => {
      localStorage.setItem(STORAGE_KEY, 'invalid');
      const { result } = renderHook(() => useSessionFilter());
      expect(result.current.filterMode).toBe('all');
    });
  });

  describe('setFilterMode', () => {
    it('should update filterMode and persist to localStorage', () => {
      const { result } = renderHook(() => useSessionFilter());

      act(() => {
        result.current.setFilterMode('mine');
      });

      expect(result.current.filterMode).toBe('mine');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('mine');
    });

    it('should toggle back to all', () => {
      const { result } = renderHook(() => useSessionFilter());

      act(() => {
        result.current.setFilterMode('mine');
      });
      act(() => {
        result.current.setFilterMode('all');
      });

      expect(result.current.filterMode).toBe('all');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('all');
    });
  });

  describe('filterSessions', () => {
    const sessions = [
      { id: 's1', createdBy: 'user-1' },
      { id: 's2', createdBy: 'user-2' },
      { id: 's3', createdBy: 'user-1' },
      { id: 's4' }, // no createdBy
    ];

    it('should return all sessions in none auth mode regardless of filter', () => {
      // authMode defaults to 'none'
      const { result } = renderHook(() => useSessionFilter());

      act(() => {
        result.current.setFilterMode('mine');
      });

      const filtered = result.current.filterSessions(sessions);
      expect(filtered).toEqual(sessions);
    });

    it('should return all sessions in multi-user mode when filterMode is all', () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

      const { result } = renderHook(() => useSessionFilter());
      const filtered = result.current.filterSessions(sessions);
      expect(filtered).toEqual(sessions);
    });

    it('should filter sessions by createdBy when mode is mine, including legacy sessions', () => {
      setAuthMode('multi-user');
      setCurrentUser({ id: 'user-1', username: 'alice', homeDir: '/home/alice' });

      const { result } = renderHook(() => useSessionFilter());

      act(() => {
        result.current.setFilterMode('mine');
      });

      const filtered = result.current.filterSessions(sessions);
      expect(filtered).toEqual([
        { id: 's1', createdBy: 'user-1' },
        { id: 's3', createdBy: 'user-1' },
        { id: 's4' }, // legacy session (no createdBy) included
      ]);
    });

    it('should return all sessions when no current user in multi-user mode', () => {
      setAuthMode('multi-user');
      // currentUser is null

      const { result } = renderHook(() => useSessionFilter());

      act(() => {
        result.current.setFilterMode('mine');
      });

      const filtered = result.current.filterSessions(sessions);
      expect(filtered).toEqual(sessions);
    });
  });

  describe('clearStoredFilterMode', () => {
    it('should remove session-filter-mode from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, 'mine');
      clearStoredFilterMode();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should not throw when localStorage is empty', () => {
      localStorage.removeItem(STORAGE_KEY);
      expect(() => clearStoredFilterMode()).not.toThrow();
    });
  });
});
