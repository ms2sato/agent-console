import type { ReactNode } from 'react';
import type { Session } from '@agent-console/shared';
import { SessionDataContext } from '../contexts/root-contexts';

/** A wire-valid quick session with overrides, for tests that read the session list from context. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    type: 'quick',
    locationPath: '/test/path',
    status: 'active',
    activationState: 'running',
    createdAt: '2026-10-15T00:00:00.000Z',
    workers: [],
    isShared: false,
    recoveryState: 'healthy',
    ...overrides,
  } as Session;
}

/** Supplies the root layout's session list to a component that reads it from context. */
export function SessionDataProvider({ sessions = [], children }: { sessions?: Session[]; children: ReactNode }) {
  return (
    <SessionDataContext.Provider value={{ sessions, wsInitialized: true, workerActivityStates: {} }}>
      {children}
    </SessionDataContext.Provider>
  );
}
