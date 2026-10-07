import { useSyncExternalStore } from 'react';
import type { AuthUser, AuthMode } from '@agent-console/shared';

let authMode: AuthMode = 'none';
let currentUser: AuthUser | null = null;
let sharedAccountsAvailable = false;
let sharedAccountsEnvVarIgnored = false;

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

export function getSharedAccountsAvailable(): boolean {
  return sharedAccountsAvailable;
}

export function setSharedAccountsAvailable(value: boolean): void {
  sharedAccountsAvailable = value;
  notifyListeners();
}

export function getSharedAccountsEnvVarIgnored(): boolean {
  return sharedAccountsEnvVarIgnored;
}

export function setSharedAccountsEnvVarIgnored(value: boolean): void {
  sharedAccountsEnvVarIgnored = value;
  notifyListeners();
}

/**
 * Subscribe to auth state changes (for useSyncExternalStore).
 * @returns Unsubscribe function
 */
export function subscribeAuth(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

interface AuthState {
  authMode: AuthMode;
  currentUser: AuthUser | null;
  isMultiUser: boolean;
  sharedAccountsAvailable: boolean;
  sharedAccountsEnvVarIgnored: boolean;
}

let cachedSnapshot: AuthState | null = null;

function getAuthSnapshot(): AuthState {
  if (
    cachedSnapshot &&
    cachedSnapshot.authMode === authMode &&
    cachedSnapshot.currentUser === currentUser &&
    cachedSnapshot.sharedAccountsAvailable === sharedAccountsAvailable &&
    cachedSnapshot.sharedAccountsEnvVarIgnored === sharedAccountsEnvVarIgnored
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = {
    authMode,
    currentUser,
    isMultiUser: authMode === 'multi-user',
    sharedAccountsAvailable,
    sharedAccountsEnvVarIgnored,
  };
  return cachedSnapshot;
}

/**
 * React hook for reactive auth state.
 * Uses useSyncExternalStore with a single subscription to re-render when auth state changes.
 */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthSnapshot);
}

/**
 * Reset auth state for testing.
 * @internal
 */
export function _reset(): void {
  authMode = 'none';
  currentUser = null;
  sharedAccountsAvailable = false;
  sharedAccountsEnvVarIgnored = false;
  cachedSnapshot = null;
  stateListeners.clear();
}
