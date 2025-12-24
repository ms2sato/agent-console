import type { WSContext } from 'hono/ws';
import type {
  AppClientMessage,
  AppServerMessage,
  Session,
  AgentActivityState,
  WorkerActivityInfo,
  AgentDefinition,
  Repository,
} from '@agent-console/shared';
import { APP_CLIENT_MESSAGE_TYPES } from '@agent-console/shared';

/**
 * Validate that a parsed message has a valid type.
 * Uses APP_CLIENT_MESSAGE_TYPES from shared package as single source of truth.
 * @internal Exported for testing
 */
export function isValidClientMessage(msg: unknown): msg is AppClientMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const { type } = msg as { type?: unknown };
  return typeof type === 'string' && type in APP_CLIENT_MESSAGE_TYPES;
}

/**
 * @internal Exported for testing
 */
export interface AppHandlerDependencies {
  getAllSessions: () => Session[];
  getWorkerActivityState: (sessionId: string, workerId: string) => AgentActivityState | undefined;
  getAllAgents: () => Promise<AgentDefinition[]>;
  getAllRepositories: () => Promise<Repository[]>;
  logger: {
    debug: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

/**
 * Build sessions-sync message payload.
 * @internal Exported for testing
 */
export function buildSessionsSyncMessage(
  deps: Pick<AppHandlerDependencies, 'getAllSessions' | 'getWorkerActivityState'>
): { type: 'sessions-sync'; sessions: Session[]; activityStates: WorkerActivityInfo[] } {
  const allSessions = deps.getAllSessions();

  // Collect activity states for all agent workers
  const activityStates: WorkerActivityInfo[] = [];
  for (const session of allSessions) {
    for (const worker of session.workers) {
      if (worker.type === 'agent') {
        const state = deps.getWorkerActivityState(session.id, worker.id);
        if (state) {
          activityStates.push({
            sessionId: session.id,
            workerId: worker.id,
            activityState: state,
          });
        }
      }
    }
  }

  return {
    type: 'sessions-sync',
    sessions: allSessions,
    activityStates,
  };
}

/**
 * Send sessions-sync message to a specific client.
 */
export function sendSessionsSync(
  ws: WSContext,
  deps: Pick<AppHandlerDependencies, 'getAllSessions' | 'getWorkerActivityState' | 'logger'>
): void {
  const syncMsg = buildSessionsSyncMessage(deps);
  ws.send(JSON.stringify(syncMsg));
  deps.logger.debug({ sessionCount: syncMsg.sessions.length }, 'Sent sessions-sync');
}

/**
 * Send agents-sync message to a specific client.
 */
export async function sendAgentsSync(
  ws: WSContext,
  deps: Pick<AppHandlerDependencies, 'getAllAgents' | 'logger'>
): Promise<void> {
  try {
    const agents = await deps.getAllAgents();
    const syncMsg: AppServerMessage = {
      type: 'agents-sync',
      agents,
    };
    ws.send(JSON.stringify(syncMsg));
    deps.logger.debug({ agentCount: agents.length }, 'Sent agents-sync');
  } catch (err) {
    deps.logger.error({ err }, 'Failed to send agents-sync');
  }
}

/**
 * Send repositories-sync message to a specific client.
 */
export async function sendRepositoriesSync(
  ws: WSContext,
  deps: Pick<AppHandlerDependencies, 'getAllRepositories' | 'logger'>
): Promise<void> {
  try {
    const repositories = await deps.getAllRepositories();
    const syncMsg: AppServerMessage = {
      type: 'repositories-sync',
      repositories,
    };
    ws.send(JSON.stringify(syncMsg));
    deps.logger.debug({ repoCount: repositories.length }, 'Sent repositories-sync');
  } catch (err) {
    deps.logger.error({ err }, 'Failed to send repositories-sync');
  }
}

/**
 * Create app WebSocket message handler with injected dependencies.
 */
export function createAppMessageHandler(deps: AppHandlerDependencies) {
  return function handleAppMessage(ws: WSContext, data: string | ArrayBuffer): void {
    const dataStr = typeof data === 'string' ? data : new TextDecoder().decode(data);

    try {
      const parsed: unknown = JSON.parse(dataStr);
      if (!isValidClientMessage(parsed)) {
        deps.logger.warn({ data: dataStr }, 'Invalid app client message');
        return;
      }

      switch (parsed.type) {
        case 'request-sync':
          deps.logger.debug({}, 'Received request-sync, sending full sync');
          // Send all sync messages in parallel
          sendSessionsSync(ws, deps);
          sendAgentsSync(ws, deps);
          sendRepositoriesSync(ws, deps);
          break;
      }
    } catch (e) {
      deps.logger.warn({ err: e, data: dataStr }, 'Failed to parse app client message');
    }
  };
}
