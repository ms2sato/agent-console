/**
 * NotificationManager - Core notification orchestration service.
 *
 * Manages outbound notifications when agent activity state changes
 * or worker lifecycle events occur. Implements state-change detection
 * and debouncing to prevent notification spam.
 *
 * Notifications are only sent when:
 * 1. The state actually changes (not repeated same state)
 * 2. The trigger is enabled in settings
 * 3. The session's repository has Slack integration configured
 */

import { createLogger } from '../../lib/logger.js';
import { serverConfig } from '../../lib/server-config.js';
import type {
  NotificationEvent,
  NotificationContext,
  AgentActivityState,
  OutboundTriggerEventType,
} from '@agent-console/shared';
import { SlackHandler } from './slack-handler.js';

const logger = createLogger('notification-manager');

/**
 * Default notification triggers configuration.
 * - agent:waiting and agent:idle are enabled by default (user needs attention)
 * - agent:active is disabled (too noisy)
 * - worker:error is enabled (important to know about errors)
 * - worker:exited is disabled (may not always be relevant)
 */
const DEFAULT_TRIGGERS: Record<OutboundTriggerEventType, boolean> = {
  'agent:waiting': true,
  'agent:idle': true,
  'agent:active': false,
  'worker:error': true,
  'worker:exited': false,
};

/**
 * Default debounce duration in seconds.
 * Waits for state to stabilize before sending notification.
 */
const DEFAULT_DEBOUNCE_SECONDS = 3;

/**
 * Minimal session info for notification context.
 * Avoids importing full Session type to prevent circular dependencies.
 */
interface SessionInfo {
  id: string;
  title?: string | null;
  worktreeId?: string | null;
  repositoryId?: string | null;
}

/**
 * Minimal worker info for notification context.
 */
interface WorkerInfo {
  id: string;
}

/**
 * Callback to validate if a session still exists.
 * Used to prevent sending notifications for deleted sessions during debounce.
 */
export type SessionExistsCallback = (sessionId: string) => boolean;

/**
 * NotificationManager class.
 *
 * Orchestrates outbound notifications:
 * - Receives activity/worker events from SessionManager
 * - Detects state changes (only notifies on actual change)
 * - Applies debouncing to prevent spam during rapid state changes
 * - Sends to repository-configured Slack webhook
 *
 * IMPORTANT: Debounce timers are stored in memory and will be lost on server restart.
 * If the server restarts during a debounce window, pending notifications will not be sent.
 * This is an acceptable tradeoff for simplicity.
 */
export class NotificationManager {
  private slackHandler: SlackHandler;
  private sessionExistsCallback: SessionExistsCallback | null = null;

  /** Previous state per session:worker for change detection */
  private previousState = new Map<string, NotificationEvent['type']>();

  /** Pending debounce timers per session:worker */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(slackHandler: SlackHandler) {
    this.slackHandler = slackHandler;

    logger.info('NotificationManager initialized');
  }

  /**
   * Check if a trigger is enabled for a given event type.
   */
  private isTriggerEnabled(eventType: OutboundTriggerEventType): boolean {
    return DEFAULT_TRIGGERS[eventType] ?? false;
  }

  /**
   * Get debounce duration in seconds.
   */
  private getDebounceSeconds(): number {
    return DEFAULT_DEBOUNCE_SECONDS;
  }

  /**
   * Get base URL for agent console from server config.
   */
  private getBaseUrl(): string {
    return serverConfig.APP_URL;
  }

  /**
   * Set the session existence callback.
   * Called during setup to inject the session validation function
   * without creating circular dependencies.
   */
  setSessionExistsCallback(callback: SessionExistsCallback): void {
    this.sessionExistsCallback = callback;
  }

  /**
   * Handle agent activity state change.
   * Called by SessionManager when ActivityDetector reports state change.
   *
   * @param session - Session info (id, title, worktreeId)
   * @param worker - Worker info (id)
   * @param newState - New activity state
   */
  onActivityChange(
    session: SessionInfo,
    worker: WorkerInfo,
    newState: AgentActivityState
  ): void {
    // Skip 'unknown' state - not a meaningful notification
    if (newState === 'unknown') {
      return;
    }

    const eventType = this.mapActivityToEventType(newState);
    if (!eventType) {
      return;
    }

    const event: NotificationEvent = this.createActivityEvent(eventType);
    this.scheduleNotification(session, worker, event);
  }

  /**
   * Handle worker error.
   * Called by SessionManager when PTY emits error.
   *
   * @param session - Session info
   * @param worker - Worker info
   * @param message - Error message
   */
  onWorkerError(
    session: SessionInfo,
    worker: WorkerInfo,
    message: string
  ): void {
    const event: NotificationEvent = {
      type: 'worker:error',
      message,
      timestamp: new Date().toISOString(),
    };

    // Errors are sent immediately without debouncing
    this.sendIfStateChanged(session, worker, event);
  }

  /**
   * Handle worker exit.
   * Called by SessionManager when PTY process exits.
   *
   * @param session - Session info
   * @param worker - Worker info
   * @param exitCode - Process exit code
   */
  onWorkerExit(
    session: SessionInfo,
    worker: WorkerInfo,
    exitCode: number
  ): void {
    const event: NotificationEvent = {
      type: 'worker:exited',
      exitCode,
      timestamp: new Date().toISOString(),
    };

    // Exit events are sent immediately without debouncing
    this.sendIfStateChanged(session, worker, event);
  }

  /**
   * Send a test notification to a specific repository's Slack webhook.
   * Used by the test notification API endpoint.
   *
   * @param repositoryId - Repository to test notification for
   * @param message - Test message to send
   */
  async sendTestNotification(repositoryId: string, message: string): Promise<void> {
    await this.slackHandler.sendTest(message, repositoryId);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.previousState.clear();

    logger.info('NotificationManager disposed');
  }

  /**
   * Clean up notification state for a deleted worker.
   * Removes previous state and cancels pending debounce timer.
   */
  cleanupWorker(sessionId: string, workerId: string): void {
    const key = `${sessionId}:${workerId}`;
    this.previousState.delete(key);
    const timer = this.debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
    logger.debug({ sessionId, workerId }, 'Cleaned up notification state for worker');
  }

  /**
   * Clean up notification state for a deleted session.
   * Removes previous state and cancels pending debounce timers.
   */
  cleanupSession(sessionId: string): void {
    // Clean up previous state
    for (const key of this.previousState.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.previousState.delete(key);
      }
    }

    // Clean up debounce timers
    for (const [key, timer] of this.debounceTimers.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }

    logger.debug({ sessionId }, 'Cleaned up notification state for session');
  }

  /** Activity event types that map from agent activity states */
  private static readonly ACTIVITY_EVENT_TYPES = ['agent:waiting', 'agent:idle', 'agent:active'] as const;

  /**
   * Map activity state to event type.
   * Returns null for states that don't map to notification events.
   *
   * Uses explicit if-else chain with exhaustive check to ensure
   * compile-time errors if new AgentActivityState values are added.
   */
  private mapActivityToEventType(
    state: AgentActivityState
  ): (typeof NotificationManager.ACTIVITY_EVENT_TYPES)[number] | null {
    if (state === 'asking') {
      return 'agent:waiting';
    } else if (state === 'idle') {
      return 'agent:idle';
    } else if (state === 'active') {
      return 'agent:active';
    } else if (state === 'unknown') {
      return null;
    } else {
      // Exhaustive check: compile error if new AgentActivityState is added
      const _exhaustive: never = state;
      throw new Error(`Unhandled activity state: ${_exhaustive}`);
    }
  }

  /**
   * Create a notification event for activity state change.
   */
  private createActivityEvent(
    type: 'agent:waiting' | 'agent:idle' | 'agent:active'
  ): NotificationEvent {
    const timestamp = new Date().toISOString();

    switch (type) {
      case 'agent:waiting':
        return { type, activityState: 'waiting', timestamp };
      case 'agent:idle':
        return { type, activityState: 'idle', timestamp };
      case 'agent:active':
        return { type, activityState: 'active', timestamp };
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unhandled activity event type: ${_exhaustive}`);
      }
    }
  }

  /**
   * Schedule notification with debouncing.
   * Waits for state to stabilize before sending.
   */
  private scheduleNotification(
    session: SessionInfo,
    worker: WorkerInfo,
    event: NotificationEvent
  ): void {
    const key = `${session.id}:${worker.id}`;
    const debounceSeconds = this.getDebounceSeconds();

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Apply debouncing if configured
    const debounceMs = debounceSeconds * 1000;
    if (debounceMs > 0) {
      // Capture session.id for the closure (session object may be stale when timer fires)
      const sessionId = session.id;
      const timer = setTimeout(() => {
        try {
          // Check if session still exists before sending notification
          // This prevents sending notifications for deleted sessions
          if (this.sessionExistsCallback && !this.sessionExistsCallback(sessionId)) {
            logger.debug({ sessionId }, 'Session deleted during debounce, skipping notification');
            return;
          }
          this.sendIfStateChanged(session, worker, event);
        } finally {
          this.debounceTimers.delete(key);
        }
      }, debounceMs);
      this.debounceTimers.set(key, timer);
    } else {
      this.sendIfStateChanged(session, worker, event);
    }
  }

  /**
   * Send notification if state has changed.
   * Only sends notification when the event type differs from previous.
   */
  private sendIfStateChanged(
    session: SessionInfo,
    worker: WorkerInfo,
    event: NotificationEvent
  ): void {
    // Check if this trigger is enabled
    if (!this.isTriggerEnabled(event.type)) {
      logger.debug(
        { sessionId: session.id, eventType: event.type },
        'Notification trigger disabled, skipping'
      );
      return;
    }

    const key = `${session.id}:${worker.id}`;
    const previousType = this.previousState.get(key);

    // Only notify on state change
    if (previousType === event.type) {
      logger.debug(
        { sessionId: session.id, eventType: event.type },
        'State unchanged, skipping notification'
      );
      return;
    }

    // Skip waiting → idle transition (user already responded, no notification needed)
    if (previousType === 'agent:waiting' && event.type === 'agent:idle') {
      logger.debug(
        { sessionId: session.id },
        'Skipping waiting→idle notification (user action result)'
      );
      this.previousState.set(key, event.type);
      return;
    }

    // Update previous state
    this.previousState.set(key, event.type);

    // Send notification asynchronously with error handling
    this.sendNotification(session, worker, event).catch(error => {
      logger.error(
        { error, sessionId: session.id, workerId: worker.id, eventType: event.type },
        'Failed to send notification'
      );
    });
  }

  /**
   * Send notification to repository's configured service handlers.
   * Async method that handles errors internally to prevent blocking callers.
   */
  private async sendNotification(
    session: SessionInfo,
    worker: WorkerInfo,
    event: NotificationEvent
  ): Promise<void> {
    const repositoryId = session.repositoryId;
    if (!repositoryId) {
      logger.debug(
        { sessionId: session.id, eventType: event.type },
        'Session has no repository, skipping notification'
      );
      return;
    }

    try {
      // Use interface method to check if handler can handle this repository
      if (!(await this.slackHandler.canHandle(repositoryId))) {
        logger.debug(
          { sessionId: session.id, repositoryId },
          'No notification handler for repository'
        );
        return;
      }

      const context = this.buildContext(session, worker, event);
      await this.slackHandler.send(context, repositoryId);

      logger.info(
        { sessionId: session.id, eventType: event.type, repositoryId },
        'Notification sent'
      );
    } catch (error) {
      logger.error(
        { error, sessionId: session.id, eventType: event.type },
        'Failed to send notification'
      );
    }
  }

  /**
   * Build notification context from session, worker, and event.
   */
  private buildContext(
    session: SessionInfo,
    worker: WorkerInfo,
    event: NotificationEvent
  ): NotificationContext {
    const baseUrl = this.getBaseUrl();
    const agentConsoleUrl = `${baseUrl}/sessions/${session.id}?workerId=${worker.id}`;

    return {
      session: {
        id: session.id,
        title: session.title ?? null,
        worktreeId: session.worktreeId ?? null,
      },
      worker: {
        id: worker.id,
      },
      event,
      agentConsoleUrl,
    };
  }
}
