/**
 * Outbound notification types for external service integration.
 *
 * These types are used to send notifications to external services (e.g., Slack)
 * when Claude Code's state changes.
 *
 * This file is the OUTBOUND (Slack) notification system; the notification
 * CENTER's wire types (the human-addressed awareness read-model) live in
 * `notification-item.ts` — see `docs/design/notification-center.md` §7.
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
 *
 * The constraint is what makes the pin fire. An earlier form resolved to
 * `never` on drift and declared a `const` of that type -- which compiles
 * cleanly, because `declare` introduces no assignment and so `never` has
 * nothing to reject. `export type` (rather than a `declare const` runtime
 * reference) is what makes THIS form fire -- `Assert<T extends true>`
 * already fails `tsc` at the alias's own declaration site when T is false,
 * so no runtime binding is needed.
 *
 * MEASURED against this repo's own compiler, both directions:
 * - Dropping `'worker:exited'` from `NotificationEvent` (leaving it in
 *   `OutboundTriggerEventType`) broke `_AssertComplete`. Old form: exit 0,
 *   no diagnostics. This form: `error TS2344: Type 'false' does not
 *   satisfy the constraint 'true'.`, exit 2.
 * - Adding a `NotificationEvent` member (`'worker:stray'`) with no matching
 *   `OutboundTriggerEventType` value broke `_AssertValidTypes`. Old form:
 *   exit 0, no diagnostics. This form: the same `error TS2344: Type
 *   'false' does not satisfy the constraint 'true'.`, exit 2.
 * Reverting each drift restored a clean `tsc --noEmit` in both cases.
 */
type Assert<T extends true> = T;

// 1. NotificationEvent types must be valid OutboundTriggerEventType
type _AssertValidTypes = Assert<NotificationEvent['type'] extends OutboundTriggerEventType ? true : false>;

// 2. All OutboundTriggerEventType must have corresponding NotificationEvent
type _AssertComplete = Assert<OutboundTriggerEventType extends NotificationEvent['type'] ? true : false>;

export type { _AssertValidTypes, _AssertComplete };

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
