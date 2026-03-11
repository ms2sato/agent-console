import { useState, useCallback, useRef } from 'react';
import type { Session, AgentActivityState, WorkerActivityInfo } from '@agent-console/shared';

interface UseSessionStateReturn {
  /** Sessions from WebSocket (source of truth after initial sync) */
  sessions: Session[];
  /** Track if we've received initial sync from WebSocket */
  wsInitialized: boolean;
  /** Activity states: { sessionId: { workerId: state } } */
  workerActivityStates: Record<string, Record<string, AgentActivityState>>;
  /** Ref to sessions for use in callbacks */
  sessionsRef: React.MutableRefObject<Session[]>;
  /** Handle initial sessions sync from WebSocket */
  handleSessionsSync: (sessions: Session[], activityStates: WorkerActivityInfo[]) => void;
  /** Handle new session created */
  handleSessionCreated: (session: Session) => void;
  /** Handle session updated */
  handleSessionUpdated: (session: Session) => void;
  /** Handle session deleted */
  handleSessionDeleted: (sessionId: string) => void;
  /** Handle session paused (removed from memory but preserved in DB) */
  handleSessionPaused: (sessionId: string, pausedAt: string) => void;
  /** Handle paused session resumed */
  handleSessionResumed: (session: Session) => void;
  /** Handle worker activity state change */
  handleWorkerActivity: (sessionId: string, workerId: string, state: AgentActivityState) => void;
}

/**
 * Upsert a session in an array: replace if exists, append if new.
 */
function upsertSession(sessions: Session[], session: Session): Session[] {
  const exists = sessions.some(s => s.id === session.id);
  if (exists) {
    return sessions.map(s => s.id === session.id ? session : s);
  }
  return [...sessions, session];
}

export function useSessionState(): UseSessionStateReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [wsInitialized, setWsInitialized] = useState(false);
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, Record<string, AgentActivityState>>>({});
  const sessionsRef = useRef<Session[]>([]);

  const handleSessionsSync = useCallback((newSessions: Session[], activityStates: WorkerActivityInfo[]) => {
    setSessions(newSessions);
    setWsInitialized(true);
    sessionsRef.current = newSessions;

    // Initialize activity states
    const newActivityStates: Record<string, Record<string, AgentActivityState>> = {};
    for (const { sessionId, workerId, activityState } of activityStates) {
      if (!newActivityStates[sessionId]) {
        newActivityStates[sessionId] = {};
      }
      newActivityStates[sessionId][workerId] = activityState;
    }
    setWorkerActivityStates(newActivityStates);
  }, []);

  const handleSessionCreated = useCallback((session: Session) => {
    setSessions(prev => [...prev, session]);
    sessionsRef.current = [...sessionsRef.current, session];
  }, []);

  // Replace-only: update existing session but do NOT append if not found.
  // This prevents stale session:updated events from resurrecting deleted sessions.
  const handleSessionUpdated = useCallback((session: Session) => {
    setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    sessionsRef.current = sessionsRef.current.map(s => s.id === session.id ? session : s);

    // Prune workerActivityStates entries for workers no longer in the updated session.
    // When a worker is deleted, the session-updated event arrives with fewer workers,
    // but stale entries would remain in the activity map without this cleanup.
    const currentWorkerIds = new Set(session.workers.map(w => w.id));
    setWorkerActivityStates(prev => {
      const sessionStates = prev[session.id];
      if (!sessionStates) return prev;

      const prunedStates: Record<string, AgentActivityState> = {};
      let changed = false;
      for (const [workerId, state] of Object.entries(sessionStates)) {
        if (currentWorkerIds.has(workerId)) {
          prunedStates[workerId] = state;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;

      if (Object.keys(prunedStates).length === 0) {
        const next = { ...prev };
        delete next[session.id];
        return next;
      }
      return { ...prev, [session.id]: prunedStates };
    });
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    sessionsRef.current = sessionsRef.current.filter(s => s.id !== sessionId);
    // Clean up activity states for this session
    setWorkerActivityStates(prev => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const handleSessionPaused = useCallback((sessionId: string, pausedAt: string) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, pausedAt, activationState: 'hibernated' } : s
    ));
    sessionsRef.current = sessionsRef.current.map(s =>
      s.id === sessionId ? { ...s, pausedAt, activationState: 'hibernated' } : s
    );
    // Clean up activity states for paused session (workers are no longer running)
    setWorkerActivityStates(prev => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const handleSessionResumed = useCallback((session: Session) => {
    setSessions(prev => upsertSession(prev, session));
    sessionsRef.current = upsertSession(sessionsRef.current, session);
  }, []);

  const handleWorkerActivity = useCallback((sessionId: string, workerId: string, state: AgentActivityState) => {
    setWorkerActivityStates(prev => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? {}), [workerId]: state },
    }));
  }, []);

  return {
    sessions,
    wsInitialized,
    workerActivityStates,
    sessionsRef,
    handleSessionsSync,
    handleSessionCreated,
    handleSessionUpdated,
    handleSessionDeleted,
    handleSessionPaused,
    handleSessionResumed,
    handleWorkerActivity,
  };
}
