import { useState, useCallback, useEffect, type MutableRefObject } from 'react'
import { getSession, ServerUnavailableError } from '../../../lib/api'
import { useAppWsEvent } from '../../../hooks/useAppWs'
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
}

export function useSessionPageState({
  sessionId,
  updateTabsFromSessionRef,
  activeTabIdRef,
}: UseSessionPageStateOptions): UseSessionPageStateReturn {
  const [state, setState] = useState<PageState>({ type: 'loading' })
  const [activityState, setActivityState] = useState<AgentActivityState>('unknown')
  const [workerActivityStates, setWorkerActivityStates] = useState<Record<string, AgentActivityState>>({})
  const [lastMessage, setLastMessage] = useState<WorkerMessage | null>(null)

  // Subscribe to app-websocket for real-time activity state updates
  // This ensures favicon updates even when page is backgrounded and worker WebSocket disconnects
  const handleWorkerActivity = useCallback((eventSessionId: string, workerId: string, newState: AgentActivityState) => {
    // Only process activity events for the current session
    if (eventSessionId !== sessionId) return

    // Update all worker activity states (for EndSessionDialog warning)
    setWorkerActivityStates(prev => ({ ...prev, [workerId]: newState }))

    // Update active tab's activity state (for status bar display)
    if (workerId === activeTabIdRef.current) {
      setActivityState(newState)
    }
  }, [sessionId, activeTabIdRef])

  const handleSessionUpdated = useCallback((updatedSession: Session) => {
    if (updatedSession.id !== sessionId) return

    updateTabsFromSessionRef.current(updatedSession.workers)
    setState(prev => {
      if (prev.type === 'active' || prev.type === 'disconnected') {
        return { ...prev, session: updatedSession }
      }
      return prev
    })
  }, [sessionId, updateTabsFromSessionRef])

  // Handle session paused (by another client or via settings menu)
  const handleSessionPaused = useCallback((pausedSessionId: string) => {
    if (pausedSessionId !== sessionId) return

    setState(prev => {
      if (prev.type === 'active' || prev.type === 'disconnected') {
        return { type: 'paused', session: prev.session }
      }
      return prev
    })
  }, [sessionId])

  // Handle session deleted (by another tab/client)
  const handleSessionDeleted = useCallback((deletedSessionId: string) => {
    if (deletedSessionId !== sessionId) return
    setState({ type: 'not_found' })
  }, [sessionId])

  // Handle session resumed (paused -> active, triggered by another client or sidebar)
  const handleSessionResumed = useCallback((resumedSession: Session) => {
    if (resumedSession.id !== sessionId) return
    setState(prev => {
      if (prev.type === 'restarting') return prev
      return { type: 'active', session: resumedSession }
    })
    updateTabsFromSessionRef.current(resumedSession.workers)
  }, [sessionId, updateTabsFromSessionRef])

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
      ;(async () => {
        try {
          const fetchedSession = await getSession(sessionId)
          if (fetchedSession?.status === 'active') {
            updateTabsFromSessionRef.current(fetchedSession.workers)
          }
          setState(prev => {
            if (prev.type === 'restarting' || prev.type === 'not_found') return prev
            if (!fetchedSession) return { type: 'not_found' }
            return sessionToPageState(fetchedSession)
          })
        } catch (error) {
          console.error('Failed to check session after sync:', error)
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

  // Load session data
  useEffect(() => {
    const checkSession = async () => {
      try {
        const session = await getSession(sessionId)
        if (!session) {
          setState({ type: 'not_found' })
          return
        }

        setState(sessionToPageState(session))
      } catch (error) {
        console.error('Failed to check session:', error)
        if (error instanceof ServerUnavailableError) {
          setState({ type: 'server_unavailable' })
        } else {
          setState({ type: 'not_found' })
        }
      }
    }

    checkSession()
  }, [sessionId])

  return {
    state,
    setState,
    workerActivityStates,
    activityState,
    setActivityState,
    lastMessage,
  }
}
