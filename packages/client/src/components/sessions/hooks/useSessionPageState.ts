import { useState, useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { getSession, ServerUnavailableError } from '../../../lib/api'
import { useAppWsEvent } from '../../../hooks/useAppWs'
import { resolveResumedState } from '../sessionResumedState'
import { logger } from '../../../lib/logger'
import type { Session, AgentActivityState, WorkerActivityInfo, WorkerMessage, Worker } from '@agent-console/shared'

export type PageState =
  | { type: 'loading' }
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session }
  | { type: 'not_found' }
  | { type: 'server_unavailable' }
  | { type: 'restarting' }
  | { type: 'paused'; session: Session }

/**
 * Canonically maps a Session to the appropriate PageState.
 * pausedAt takes precedence over status (a session can be status='active' with pausedAt set during edge cases).
 *
 * @internal - exported for testing
 */
export function sessionToPageState(session: Session): Extract<PageState, { session: Session }> {
  if (session.pausedAt) {
    return { type: 'paused', session }
  }
  if (session.status === 'active') {
    return { type: 'active', session }
  }
  return { type: 'disconnected', session }
}

export interface UseSessionPageStateOptions {
  sessionId: string
  /** Ref-based to decouple from useTabManagement hook ordering */
  updateTabsFromSessionRef: MutableRefObject<(workers: Worker[]) => void>
  activeTabIdRef: MutableRefObject<string | null>
}

export interface UseSessionPageStateReturn {
  state: PageState
  setState: React.Dispatch<React.SetStateAction<PageState>>
  workerActivityStates: Record<string, AgentActivityState>
  activityState: AgentActivityState
  setActivityState: React.Dispatch<React.SetStateAction<AgentActivityState>>
  lastMessage: WorkerMessage | null
  resumeKey: number
  retryLoadSession: () => void
}

export function useSessionPageState({
  sessionId,
  updateTabsFromSessionRef,
  activeTabIdRef,
}: UseSessionPageStateOptions): UseSessionPageStateReturn {
  const [state, setState] = useState<PageState>({ type: 'loading' })
  // Ref mirror of state: callbacks that trigger side effects based on current state
  // must read this ref because React 18 automatic batching defers setState updaters.
  const stateRef = useRef(state)
  stateRef.current = state
  const [activityState, setActivityState] = useState<AgentActivityState>('unknown')
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, AgentActivityState>>({})
  const [lastMessage, setLastMessage] = useState<WorkerMessage | null>(null)
  const [resumeKey, setResumeKey] = useState(0)
  const [loadTrigger, setLoadTrigger] = useState(0)
  const syncRequestIdRef = useRef(0)

  const handleWorkerActivity = useCallback((eventSessionId: string, workerId: string, newState: AgentActivityState) => {
    if (eventSessionId !== sessionId) return

    setWorkerActivityStates(prev => ({ ...prev, [workerId]: newState }))

    // Sync the active tab's activity state for status bar display
    if (workerId === activeTabIdRef.current) {
      setActivityState(newState)
    }
  }, [sessionId, activeTabIdRef])

  const handleSessionUpdated = useCallback((updatedSession: Session) => {
    if (updatedSession.id !== sessionId) return

    setState(prev => {
      if (prev.type === 'active' || prev.type === 'disconnected' || prev.type === 'paused') {
        return { ...prev, session: updatedSession }
      }
      return prev
    })
    // Only sync tabs when session is active (stateRef avoids React 18 batching staleness)
    if (stateRef.current.type === 'active') {
      updateTabsFromSessionRef.current(updatedSession.workers)
    }
  }, [sessionId, updateTabsFromSessionRef])

  // Handle session paused (by another client or via settings menu)
  const handleSessionPaused = useCallback((pausedSession: Session) => {
    if (pausedSession.id !== sessionId) return

    setState(sessionToPageState(pausedSession))
  }, [sessionId])

  // Handle session deleted (by another tab/client)
  const handleSessionDeleted = useCallback((deletedSessionId: string) => {
    if (deletedSessionId !== sessionId) return
    setState({ type: 'not_found' })
  }, [sessionId])

  // Handle session resumed (paused -> active, triggered by another client or sidebar)
  const handleSessionResumed = useCallback((resumedSession: Session, activityStates: WorkerActivityInfo[]) => {
    if (resumedSession.id !== sessionId) return
    if (stateRef.current.type === 'restarting') return

    const nextState = resolveResumedState(resumedSession)
    setState(nextState)
    setResumeKey(prev => prev + 1)
    if (nextState.type === 'active') {
      updateTabsFromSessionRef.current(resumedSession.workers)
    }

    // Rebuild worker activity states from the payload (same pattern as handleSessionsSync)
    const sessionActivities: Record<string, AgentActivityState> = {}
    for (const info of activityStates) {
      if (info.sessionId === sessionId) {
        sessionActivities[info.workerId] = info.activityState
      }
    }
    setWorkerActivityStates(sessionActivities)
  }, [sessionId, updateTabsFromSessionRef])

  // Handle worker restarted: reset activity state for the restarted worker
  const handleWorkerRestarted = useCallback((eventSessionId: string, workerId: string, activityState: AgentActivityState) => {
    if (eventSessionId !== sessionId) return

    setWorkerActivityStates(prev => ({ ...prev, [workerId]: activityState }))

    // Sync the active tab's activity state for status bar display
    if (workerId === activeTabIdRef.current) {
      setActivityState(activityState)
    }
  }, [sessionId, activeTabIdRef])

  // Handle sessions-sync (fires after WebSocket reconnects to reconcile stale state)
  const handleSessionsSync = useCallback((syncedSessions: Session[], activityStates: WorkerActivityInfo[]) => {
    const session = syncedSessions.find(s => s.id === sessionId)

    if (session) {
      // Session exists in sync - reconcile state directly
      updateTabsFromSessionRef.current(session.workers)

      setState(prev => {
        // Don't interrupt ongoing restart operations
        if (prev.type === 'restarting') return prev
        return sessionToPageState(session)
      })

      // Refresh worker activity states for this session
      const sessionActivities: Record<string, AgentActivityState> = {}
      for (const info of activityStates) {
        if (info.sessionId === sessionId) {
          sessionActivities[info.workerId] = info.activityState
        }
      }
      setWorkerActivityStates(sessionActivities)
    } else {
      // Session missing from sync - check if it's paused in DB or deleted
      const requestId = ++syncRequestIdRef.current
      ;(async () => {
        try {
          const fetchedSession = await getSession(sessionId)
          if (syncRequestIdRef.current !== requestId) return  // stale response
          if (stateRef.current.type === 'restarting' || stateRef.current.type === 'not_found') return

          if (!fetchedSession) {
            setState({ type: 'not_found' })
            return
          }

          const nextState = sessionToPageState(fetchedSession)
          if (nextState.type === 'active') {
            updateTabsFromSessionRef.current(fetchedSession.workers)
          }
          setState(nextState)
        } catch (error) {
          if (syncRequestIdRef.current !== requestId) return  // stale response
          logger.error('Failed to check session after sync:', error)
          if (error instanceof ServerUnavailableError) {
            setState({ type: 'server_unavailable' })
          }
        }
      })()
    }
  }, [sessionId, updateTabsFromSessionRef])

  useAppWsEvent({
    onSessionsSync: handleSessionsSync,
    onWorkerActivity: handleWorkerActivity,
    onWorkerRestarted: handleWorkerRestarted,
    onWorkerMessage: (message) => {
      if (message.sessionId === sessionId) {
        setLastMessage(message)
      }
    },
    onSessionUpdated: handleSessionUpdated,
    onSessionPaused: handleSessionPaused,
    onSessionDeleted: handleSessionDeleted,
    onSessionResumed: handleSessionResumed,
  })

  const retryLoadSession = useCallback(() => {
    setState({ type: 'loading' })
    setLoadTrigger(prev => prev + 1)
  }, [])

  // Load session data
  useEffect(() => {
    let cancelled = false

    const checkSession = async () => {
      try {
        const session = await getSession(sessionId)
        if (cancelled) return

        if (!session) {
          setState({ type: 'not_found' })
          return
        }

        setState(sessionToPageState(session))
      } catch (error) {
        if (cancelled) return
        logger.error('Failed to check session:', error)
        if (error instanceof ServerUnavailableError) {
          setState({ type: 'server_unavailable' })
        } else {
          setState({ type: 'not_found' })
        }
      }
    }

    checkSession()
    return () => { cancelled = true }
  }, [sessionId, loadTrigger])

  return {
    state,
    setState,
    workerActivityStates,
    activityState,
    setActivityState,
    lastMessage,
    resumeKey,
    retryLoadSession,
  }
}
