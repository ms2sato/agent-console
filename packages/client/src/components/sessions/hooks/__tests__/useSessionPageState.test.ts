import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import type { Session, Worker, AgentActivityState, WorkerActivityInfo, WorkerMessage } from '@agent-console/shared'

// --- useAppWsEvent mock ---
//
// We mock useAppWsEvent to capture the callbacks the hook registers.
// This avoids coupling to the WebSocket transport layer (already tested in useAppWs.test.ts)
// and prevents interference from other test files that mock the same module via mock.module
// (e.g., __root.test.tsx).

interface CapturedCallbacks {
  onSessionsSync?: (sessions: Session[], activityStates: WorkerActivityInfo[]) => void
  onWorkerActivity?: (sessionId: string, workerId: string, state: AgentActivityState) => void
  onWorkerMessage?: (message: WorkerMessage) => void
  onSessionUpdated?: (session: Session) => void
  onSessionPaused?: (sessionId: string, pausedAt: string) => void
  onSessionDeleted?: (sessionId: string) => void
  onSessionResumed?: (session: Session) => void
}

let capturedCallbacks: CapturedCallbacks = {}

mock.module('../../../../hooks/useAppWs', () => ({
  useAppWsEvent: (options: CapturedCallbacks) => {
    capturedCallbacks = options
  },
  useAppWsState: () => false,
}))

// Must import AFTER mock.module
import { renderHook, act } from '@testing-library/react'
import { useSessionPageState, type UseSessionPageStateOptions } from '../useSessionPageState'

// --- Fetch-level mocking ---

const originalFetch = globalThis.fetch

type SessionResponse = Session | null | 'throw' | 'throw-server-unavailable'

let getSessionResponse: SessionResponse = null

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

  // GET /api/sessions/:sessionId -> getSession
  if (method === 'GET' && /\/sessions\/[^/]+$/.test(url)) {
    if (getSessionResponse === 'throw') {
      throw new TypeError('fetch failed')
    }
    if (getSessionResponse === 'throw-server-unavailable') {
      return new Response(JSON.stringify({ error: 'Server unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (getSessionResponse === null) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ session: getSessionResponse }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('Not Found', { status: 404 })
})

// Install fetch mock at module level (consistent with useTabManagement.test.ts)
globalThis.fetch = mockFetch as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

// --- Test helpers ---

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feat/test',
    isMainWorktree: false,
    locationPath: '/path/to/worktree',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [
      { id: 'agent-worker-1', type: 'agent', name: 'Claude Code', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
      { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
    ],
    ...overrides,
  } as Session
}

function createMockRefs() {
  const updateTabsFromSession = mock(() => {})
  const updateTabsFromSessionRef = { current: updateTabsFromSession } as React.MutableRefObject<(w: Worker[]) => void>
  const activeTabIdRef = { current: 'agent-worker-1' } as React.MutableRefObject<string | null>
  return { updateTabsFromSession, updateTabsFromSessionRef, activeTabIdRef }
}

function createDefaultOptions(overrides: Partial<UseSessionPageStateOptions> = {}): UseSessionPageStateOptions {
  const refs = createMockRefs()
  return {
    sessionId: 'session-1',
    updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
    activeTabIdRef: refs.activeTabIdRef,
    ...overrides,
  }
}

/**
 * Mount the hook and wait for initial load to complete.
 * After mounting, capturedCallbacks contains the WS event handlers registered by the hook.
 */
async function mountHook(options: UseSessionPageStateOptions) {
  const hookResult = renderHook(() => useSessionPageState(options))

  // Flush initial load fetch
  await act(async () => {})

  return hookResult
}

// --- Test suite ---

describe('useSessionPageState', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})

    capturedCallbacks = {}
    mockFetch.mockClear()
    getSessionResponse = null
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('initial load', () => {
    it('should transition to active when session is active', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      expect(result.current.state.type).toBe('active')
      if (result.current.state.type === 'active') {
        expect(result.current.state.session.id).toBe('session-1')
      }
    })

    it('should transition to paused when session has pausedAt', async () => {
      const session = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      expect(result.current.state.type).toBe('paused')
    })

    it('should transition to disconnected when session is inactive', async () => {
      const session = createMockSession({ status: 'inactive' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      expect(result.current.state.type).toBe('disconnected')
    })

    it('should transition to not_found when session does not exist', async () => {
      getSessionResponse = null

      const { result } = await mountHook(createDefaultOptions())

      expect(result.current.state.type).toBe('not_found')
    })

    it('should transition to server_unavailable when fetch throws TypeError', async () => {
      getSessionResponse = 'throw'

      const { result } = await mountHook(createDefaultOptions())

      expect(result.current.state.type).toBe('server_unavailable')
    })
  })

  describe('sessions-sync (session found in sync)', () => {
    it('should transition from disconnected to active', async () => {
      const disconnectedSession = createMockSession({ status: 'inactive' })
      getSessionResponse = disconnectedSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      expect(result.current.state.type).toBe('disconnected')

      const activeSession = createMockSession({ status: 'active' })
      act(() => {
        capturedCallbacks.onSessionsSync?.(
          [activeSession],
          [],
        )
      })

      expect(result.current.state.type).toBe('active')
      expect(refs.updateTabsFromSession).toHaveBeenCalledWith(activeSession.workers)
    })

    it('should transition from active to paused', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      act(() => {
        capturedCallbacks.onSessionsSync?.([pausedSession], [])
      })

      expect(result.current.state.type).toBe('paused')
    })

    it('should transition from active to disconnected', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      const inactiveSession = createMockSession({ status: 'inactive' })
      act(() => {
        capturedCallbacks.onSessionsSync?.([inactiveSession], [])
      })

      expect(result.current.state.type).toBe('disconnected')
    })

    it('should preserve restarting state during sync', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        result.current.setState({ type: 'restarting' })
      })
      expect(result.current.state.type).toBe('restarting')

      act(() => {
        capturedCallbacks.onSessionsSync?.([activeSession], [])
      })

      expect(result.current.state.type).toBe('restarting')
    })

    it('should refresh activity states from sync data', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const refs = createMockRefs()
      refs.activeTabIdRef.current = 'agent-worker-1'
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)

      const activityStates: WorkerActivityInfo[] = [
        { sessionId: 'session-1', workerId: 'agent-worker-1', activityState: 'active' },
        { sessionId: 'session-1', workerId: 'terminal-worker-1', activityState: 'idle' },
        { sessionId: 'other-session', workerId: 'worker-x', activityState: 'asking' },
      ]

      act(() => {
        capturedCallbacks.onSessionsSync?.([activeSession], activityStates)
      })

      expect(result.current.workerActivityStates).toEqual({
        'agent-worker-1': 'active',
        'terminal-worker-1': 'idle',
      })
    })

    it('should call updateTabsFromSession with session workers', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      await mountHook(options)

      refs.updateTabsFromSession.mockClear()

      act(() => {
        capturedCallbacks.onSessionsSync?.([activeSession], [])
      })

      expect(refs.updateTabsFromSession).toHaveBeenCalledWith(activeSession.workers)
    })
  })

  describe('sessions-sync (REST fallback - session NOT in sync)', () => {
    it('should fetch from REST and transition to paused when fetched session is paused', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      getSessionResponse = pausedSession

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('paused')
    })

    it('should transition to not_found when REST returns null', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      getSessionResponse = null

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('not_found')
    })

    it('should transition to active and call updateTabsFromSession when REST returns active', async () => {
      const inactiveSession = createMockSession({ status: 'inactive' })
      getSessionResponse = inactiveSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      expect(result.current.state.type).toBe('disconnected')

      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      refs.updateTabsFromSession.mockClear()

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('active')
      expect(refs.updateTabsFromSession).toHaveBeenCalledWith(activeSession.workers)
    })

    it('should transition to server_unavailable when REST throws ServerUnavailableError', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      getSessionResponse = 'throw-server-unavailable'

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('server_unavailable')
    })

    it('should preserve restarting state during REST fallback', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        result.current.setState({ type: 'restarting' })
      })

      getSessionResponse = createMockSession({ status: 'active' })

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('restarting')
    })

    it('should NOT call updateTabsFromSession when session has status=active but pausedAt set', async () => {
      const inactiveSession = createMockSession({ status: 'inactive' })
      getSessionResponse = inactiveSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      refs.updateTabsFromSession.mockClear()

      // Edge case: status=active but pausedAt set - sessionToPageState returns 'paused'
      const edgeCaseSession = createMockSession({ status: 'active', pausedAt: '2026-01-01T00:00:00Z' })
      getSessionResponse = edgeCaseSession

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('paused')
      expect(refs.updateTabsFromSession).not.toHaveBeenCalled()
    })
  })

  describe('full reconnect flow', () => {
    it('should reconcile state after WS disconnect and reconnect', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      expect(result.current.state.type).toBe('active')

      const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      act(() => {
        capturedCallbacks.onSessionsSync?.([pausedSession], [])
      })

      expect(result.current.state.type).toBe('paused')
    })

    it('should handle session deleted during disconnect', async () => {
      const activeSession = createMockSession({ status: 'active' })
      getSessionResponse = activeSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      getSessionResponse = null

      await act(async () => {
        capturedCallbacks.onSessionsSync?.([], [])
      })

      expect(result.current.state.type).toBe('not_found')
    })
  })

  describe('session-updated', () => {
    it('should update session data and call updateTabsFromSession', async () => {
      const session = createMockSession({ status: 'active', title: 'Original' })
      getSessionResponse = session

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)

      refs.updateTabsFromSession.mockClear()

      const updatedSession = createMockSession({
        status: 'active',
        title: 'Updated Title',
        workers: [
          { id: 'agent-worker-1', type: 'agent', name: 'Claude Code', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
          { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
          { id: 'terminal-worker-2', type: 'terminal', name: 'Shell 2', createdAt: new Date().toISOString(), activated: true },
        ] as Worker[],
      })

      act(() => {
        capturedCallbacks.onSessionUpdated?.(updatedSession)
      })

      expect(result.current.state.type).toBe('active')
      if (result.current.state.type === 'active') {
        expect(result.current.state.session.title).toBe('Updated Title')
      }
      expect(refs.updateTabsFromSession).toHaveBeenCalledWith(updatedSession.workers)
    })

    it('should ignore events for other sessions', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)

      refs.updateTabsFromSession.mockClear()

      const otherSession = createMockSession({ id: 'other-session', title: 'Other' })

      act(() => {
        capturedCallbacks.onSessionUpdated?.(otherSession)
      })

      if (result.current.state.type === 'active') {
        expect(result.current.state.session.id).toBe('session-1')
      }
      expect(refs.updateTabsFromSession).not.toHaveBeenCalled()
    })

    it('should update session data when state is paused', async () => {
      const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      getSessionResponse = pausedSession

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('paused')

      const updatedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z', title: 'Updated While Paused' })

      act(() => {
        capturedCallbacks.onSessionUpdated?.(updatedSession)
      })

      expect(result.current.state.type).toBe('paused')
      if (result.current.state.type === 'paused') {
        expect(result.current.state.session.title).toBe('Updated While Paused')
      }
    })
  })

  describe('session-paused', () => {
    it('should transition active to paused and apply pausedAt to session', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      const pausedAt = '2026-01-01T00:00:00.000Z'
      act(() => {
        capturedCallbacks.onSessionPaused?.('session-1', pausedAt)
      })

      expect(result.current.state.type).toBe('paused')
      if (result.current.state.type === 'paused') {
        expect(result.current.state.session.pausedAt).toBe(pausedAt)
      }
    })

    it('should transition disconnected to paused and apply pausedAt to session', async () => {
      const session = createMockSession({ status: 'inactive' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('disconnected')

      const pausedAt = '2026-01-01T00:00:00.000Z'
      act(() => {
        capturedCallbacks.onSessionPaused?.('session-1', pausedAt)
      })

      expect(result.current.state.type).toBe('paused')
      if (result.current.state.type === 'paused') {
        expect(result.current.state.session.pausedAt).toBe(pausedAt)
      }
    })

    it('should ignore events for other sessions', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        capturedCallbacks.onSessionPaused?.('other-session', new Date().toISOString())
      })

      expect(result.current.state.type).toBe('active')
    })
  })

  describe('session-deleted', () => {
    it('should transition to not_found', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.state.type).toBe('active')

      act(() => {
        capturedCallbacks.onSessionDeleted?.('session-1')
      })

      expect(result.current.state.type).toBe('not_found')
    })
  })

  describe('session-resumed', () => {
    it('should transition paused to active and call updateTabsFromSession', async () => {
      const pausedSession = createMockSession({ status: 'inactive', pausedAt: '2026-01-01T00:00:00Z' })
      getSessionResponse = pausedSession

      const refs = createMockRefs()
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      expect(result.current.state.type).toBe('paused')

      refs.updateTabsFromSession.mockClear()

      const resumedSession = createMockSession({ status: 'active' })

      act(() => {
        capturedCallbacks.onSessionResumed?.(resumedSession)
      })

      expect(result.current.state.type).toBe('active')
      if (result.current.state.type === 'active') {
        expect(result.current.state.session).toEqual(resumedSession)
      }
      expect(refs.updateTabsFromSession).toHaveBeenCalledWith(resumedSession.workers)
    })

    it('should preserve restarting state', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        result.current.setState({ type: 'restarting' })
      })

      const resumedSession = createMockSession({ status: 'active' })

      act(() => {
        capturedCallbacks.onSessionResumed?.(resumedSession)
      })

      expect(result.current.state.type).toBe('restarting')
    })

    it('should ignore events for other sessions', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      const otherSession = createMockSession({ id: 'other-session', status: 'active' })

      act(() => {
        capturedCallbacks.onSessionResumed?.(otherSession)
      })

      expect(result.current.state.type).toBe('active')
      if (result.current.state.type === 'active') {
        expect(result.current.state.session.id).toBe('session-1')
      }
    })
  })

  describe('worker-activity', () => {
    it('should update workerActivityStates', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        capturedCallbacks.onWorkerActivity?.('session-1', 'agent-worker-1', 'active')
      })

      expect(result.current.workerActivityStates['agent-worker-1']).toBe('active')
    })

    it('should sync activityState when worker matches activeTabIdRef', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const refs = createMockRefs()
      refs.activeTabIdRef.current = 'agent-worker-1'
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)
      expect(result.current.activityState).toBe('unknown')

      act(() => {
        capturedCallbacks.onWorkerActivity?.('session-1', 'agent-worker-1', 'asking')
      })

      expect(result.current.activityState).toBe('asking')
    })

    it('should not sync activityState for non-active tab workers', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const refs = createMockRefs()
      refs.activeTabIdRef.current = 'agent-worker-1'
      const options = createDefaultOptions({
        updateTabsFromSessionRef: refs.updateTabsFromSessionRef,
        activeTabIdRef: refs.activeTabIdRef,
      })

      const { result } = await mountHook(options)

      act(() => {
        capturedCallbacks.onWorkerActivity?.('session-1', 'terminal-worker-1', 'idle')
      })

      expect(result.current.activityState).toBe('unknown')
      expect(result.current.workerActivityStates['terminal-worker-1']).toBe('idle')
    })

    it('should ignore events for other sessions', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      act(() => {
        capturedCallbacks.onWorkerActivity?.('other-session', 'agent-worker-1', 'active')
      })

      expect(result.current.workerActivityStates).toEqual({})
    })
  })

  describe('worker-message', () => {
    it('should update lastMessage', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())
      expect(result.current.lastMessage).toBeNull()

      const message: WorkerMessage = {
        id: 'msg-1',
        sessionId: 'session-1',
        fromWorkerId: 'agent-worker-1',
        fromWorkerName: 'Claude Code',
        toWorkerId: 'terminal-worker-1',
        toWorkerName: 'Terminal',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      }

      act(() => {
        capturedCallbacks.onWorkerMessage?.(message)
      })

      expect(result.current.lastMessage).toEqual(message)
    })

    it('should ignore messages for other sessions', async () => {
      const session = createMockSession({ status: 'active' })
      getSessionResponse = session

      const { result } = await mountHook(createDefaultOptions())

      const message: WorkerMessage = {
        id: 'msg-1',
        sessionId: 'other-session',
        fromWorkerId: 'agent-worker-1',
        fromWorkerName: 'Claude Code',
        toWorkerId: 'terminal-worker-1',
        toWorkerName: 'Terminal',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      }

      act(() => {
        capturedCallbacks.onWorkerMessage?.(message)
      })

      expect(result.current.lastMessage).toBeNull()
    })
  })
})
