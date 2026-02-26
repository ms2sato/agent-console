import type {
  InboundEventType,
  InboundEventSummary,
  InboundSystemEvent,
} from '@agent-console/shared';
import type { SessionManager } from '../session-manager.js';
import { triggerRefresh } from '../git-diff-service.js';
import { writePtyNotification } from '../../lib/pty-notification.js';
import { createLogger } from '../../lib/logger.js';

export interface EventTarget {
  sessionId: string;
  workerId?: string;
}

export interface InboundEventHandler {
  /** Handler identifier */
  readonly handlerId: string;
  /** Event types this handler supports (inbound events only) */
  readonly supportedEvents: InboundEventType[];
  /**
   * Handle the event for a specific target.
   * @param event - The inbound event (already validated by job-handler)
   * @param target - The target session/worker to notify
   * @returns true if the handler performed an action, false if skipped
   */
  handle(event: InboundSystemEvent, target: EventTarget): Promise<boolean>;
}

export interface InboundHandlerDependencies {
  sessionManager: SessionManager;
  broadcastToApp: (message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => void;
}

export function createInboundHandlers(deps: InboundHandlerDependencies): InboundEventHandler[] {
  return [
    new AgentWorkerHandler(deps.sessionManager),
    new DiffWorkerHandler(deps.sessionManager),
    new UINotificationHandler(deps.broadcastToApp),
  ];
}

const handlerLogger = createLogger('inbound-handlers');

class AgentWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'agent-worker';
  readonly supportedEvents: InboundEventType[] = ['ci:completed', 'ci:failed', 'pr:review_comment'];
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  async handle(event: InboundSystemEvent, target: EventTarget): Promise<boolean> {
    const session = this.sessionManager.getSession(target.sessionId);
    if (!session) return false;

    const workerId = target.workerId ?? session.workers.find((worker) => worker.type === 'agent')?.id;
    if (!workerId) return false;

    const sessionId = target.sessionId;
    try {
      writePtyNotification({
        tag: `inbound:${event.type}`,
        fields: {
          type: event.type,
          source: event.source,
          repo: event.metadata.repositoryName ?? 'unknown',
          branch: event.metadata.branch ?? 'unknown',
          url: event.metadata.url ?? 'N/A',
          summary: event.summary,
          intent: event.type === 'ci:failed' || event.type === 'pr:review_comment' ? 'triage' : 'inform',
        },
        writeInput: (data) => this.sessionManager.writeWorkerInput(sessionId, workerId, data),
      });
    } catch (err) {
      handlerLogger.warn(
        { err, sessionId, workerId, eventType: event.type },
        'PTY notification failed for inbound event',
      );
      return false;
    }

    return true;
  }
}

class DiffWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'diff-worker';
  readonly supportedEvents: InboundEventType[] = ['ci:completed', 'pr:merged'];
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  async handle(_event: InboundSystemEvent, target: EventTarget): Promise<boolean> {
    const session = this.sessionManager.getSession(target.sessionId);
    if (!session) return false;

    const hasDiffWorker = session.workers.some((worker) => worker.type === 'git-diff');
    if (!hasDiffWorker) return false;

    triggerRefresh(session.locationPath);
    return true;
  }
}

class UINotificationHandler implements InboundEventHandler {
  readonly handlerId = 'ui-notification';
  readonly supportedEvents: InboundEventType[] = ['ci:failed', 'issue:closed', 'pr:merged', 'pr:review_comment'];
  private broadcastToApp: InboundHandlerDependencies['broadcastToApp'];

  constructor(broadcastToApp: InboundHandlerDependencies['broadcastToApp']) {
    this.broadcastToApp = broadcastToApp;
  }

  async handle(event: InboundSystemEvent, target: EventTarget): Promise<boolean> {
    this.broadcastToApp({
      type: 'inbound-event',
      sessionId: target.sessionId,
      event: {
        type: event.type,
        source: event.source,
        summary: event.summary,
        metadata: event.metadata,
      },
    });
    return true;
  }
}
