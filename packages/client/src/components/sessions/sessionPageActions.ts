import type { Session, Worker } from '@agent-console/shared'
import { sessionToPageState, type PageState } from './hooks/useSessionPageState'

export interface HandleWorkerRestartDeps {
  restartAgentWorker: (sessionId: string, workerId: string, continueConversation: boolean) => Promise<{ worker: Worker }>
  getSession: (sessionId: string) => Promise<Session | null>
  showError: (title: string, message: string) => void
  updateTabsFromSession: (workers: Worker[]) => void
}

export async function handleWorkerRestart(
  state: PageState,
  sessionId: string,
  continueConversation: boolean,
  deps: HandleWorkerRestartDeps,
): Promise<PageState> {
  const session = (state.type === 'active' || state.type === 'disconnected') ? state.session : null
  if (!session) return state

  const agentWorker = session.workers.find(w => w.type === 'agent')
  if (!agentWorker) {
    deps.showError('Restart Failed', 'No agent worker found in session')
    return state
  }

  try {
    await deps.restartAgentWorker(sessionId, agentWorker.id, continueConversation)

    const updatedSession = await deps.getSession(sessionId)
    if (!updatedSession) {
      return { type: 'not_found' }
    }
    const nextState = sessionToPageState(updatedSession)
    if (nextState.type === 'active') {
      deps.updateTabsFromSession([])
    }
    return nextState
  } catch (error) {
    deps.showError('Restart Failed', error instanceof Error ? error.message : 'Failed to restart session')
    return { type: 'disconnected', session }
  }
}
