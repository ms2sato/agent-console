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
  /** Handle worker activity state change */
  handleWorkerActivity: (sessionId: string, workerId: string, state: AgentActivityState) => void;
  /** Set sessions from REST API fallback */
  setSessionsFromApi: (sessions: Session[]) => void;
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

  const handleSessionUpdated = useCallback((session: Session) => {
    setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    sessionsRef.current = sessionsRef.current.map(s => s.id === session.id ? session : s);
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

  const handleWorkerActivity = useCallback((sessionId: string, workerId: string, state: AgentActivityState) => {
    setWorkerActivityStates(prev => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? {}), [workerId]: state },
    }));
  }, []);

  const setSessionsFromApi = useCallback((apiSessions: Session[]) => {
    if (!wsInitialized) {
      sessionsRef.current = apiSessions;
    }
  }, [wsInitialized]);

  return {
    sessions,
    wsInitialized,
    workerActivityStates,
    sessionsRef,
    handleSessionsSync,
    handleSessionCreated,
    handleSessionUpdated,
    handleSessionDeleted,
    handleWorkerActivity,
    setSessionsFromApi,
  };
}
