/**
 * Outbound notification types for external service integration.
 *
 * These types are used to send notifications to external services (e.g., Slack)
 * when Claude Code's state changes.
 */

import type { IntegrationType } from './integration.js';

// === Outbound Event Types ===

/**
 * Event types that can trigger outbound notifications.
 * These map to agent activity state changes and worker lifecycle events.
 */
export type OutboundTriggerEventType =
  | 'agent:waiting'   // Agent is asking a question
  | 'agent:idle'      // Agent finished processing
  | 'agent:active'    // Agent is actively processing
  | 'worker:error'    // Worker encountered an error
  | 'worker:exited';  // Worker process exited

/**
 * Internal event format for outbound notifications.
 * Each event type has specific payload for UI presentation.
 * Discriminated union by 'type' field.
 *
 * Note: timestamp is ISO 8601 string for consistency with SystemEvent
 */
export type NotificationEvent =
  | { type: 'agent:waiting'; activityState: 'waiting'; timestamp: string }
  | { type: 'agent:idle'; activityState: 'idle'; timestamp: string }
  | { type: 'agent:active'; activityState: 'active'; timestamp: string }
  | { type: 'worker:error'; message: string; timestamp: string }
  | { type: 'worker:exited'; exitCode: number; timestamp: string };

// === Compile-time Type Assertions ===

/**
 * Bidirectional type assertions to ensure type safety:
 * 1. NotificationEvent types must be valid OutboundTriggerEventType
 * 2. All OutboundTriggerEventType must have corresponding NotificationEvent
 */

// 1. NotificationEvent types must be valid OutboundTriggerEventType
type _AssertValidTypes = NotificationEvent['type'] extends OutboundTriggerEventType
  ? true
  : never;

// 2. All OutboundTriggerEventType must have corresponding NotificationEvent
type _AssertComplete = OutboundTriggerEventType extends NotificationEvent['type']
  ? true
  : never;  // Compile error if any OutboundTriggerEventType is missing from NotificationEvent

// Prevent unused type warnings (these are for compile-time checks only)
declare const _typeAssertions: _AssertValidTypes & _AssertComplete;

// === Service Handler Interface ===

/**
 * Interface for outbound service handlers.
 * Each service (Slack, etc.) implements this interface.
 */
export interface OutboundServiceHandler {
  /** Integration type identifier */
  readonly integrationType: IntegrationType;

  /**
   * Check if this handler can send notifications for the given repository.
   * Returns true if the repository has this service configured and enabled.
   */
  canHandle(repositoryId: string): Promise<boolean>;

  /**
   * Send notification to the service.
   * The handler is responsible for looking up its own configuration.
   */
  send(context: NotificationContext, repositoryId: string): Promise<void>;
}

// === Notification Context ===

/**
 * Context passed to service handlers when sending notifications.
 * Contains all information needed to format and send a notification.
 */
export interface NotificationContext {
  /** Session information (subset to avoid circular dependencies) */
  session: {
    id: string;
    title: string | null;
    worktreeId: string | null;
  };

  /** Worker information */
  worker: {
    id: string;
  };

  /** The notification event that triggered this notification */
  event: NotificationEvent;

  /** Full URL to access this session/worker in Agent Console */
  agentConsoleUrl: string;
}

// === Repository-level Integration Settings ===

/**
 * Repository-level Slack integration settings.
 * Allows per-repository webhook URL configuration.
 */
export interface RepositorySlackIntegration {
  id: string;
  repositoryId: string;
  webhookUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
