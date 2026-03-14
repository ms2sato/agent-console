import { useSyncExternalStore } from 'react';
import type { AuthUser, AuthMode } from '@agent-console/shared';

let authMode: AuthMode = 'none';
let currentUser: AuthUser | null = null;

const stateListeners = new Set<() => void>();

function notifyListeners(): void {
  stateListeners.forEach(fn => fn());
}

export function getAuthMode(): AuthMode {
  return authMode;
}

export function setAuthMode(mode: AuthMode): void {
  authMode = mode;
  notifyListeners();
}

export function getCurrentUser(): AuthUser | null {
  return currentUser;
}

export function setCurrentUser(user: AuthUser | null): void {
  currentUser = user;
  notifyListeners();
}

export function isMultiUserMode(): boolean {
  return authMode === 'multi-user';
}

/**
 * Subscribe to auth state changes (for useSyncExternalStore).
 * @returns Unsubscribe function
 */
export function subscribeAuth(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * React hook for reactive auth state.
 * Uses useSyncExternalStore to re-render when auth state changes.
 */
export function useAuth(): {
  authMode: AuthMode;
  currentUser: AuthUser | null;
  isMultiUser: boolean;
} {
  const mode = useSyncExternalStore(subscribeAuth, getAuthMode);
  const user = useSyncExternalStore(subscribeAuth, getCurrentUser);
  return { authMode: mode, currentUser: user, isMultiUser: mode === 'multi-user' };
}

/**
 * Reset auth state for testing.
 * @internal
 */
export function _reset(): void {
  authMode = 'none';
  currentUser = null;
  stateListeners.clear();
}
