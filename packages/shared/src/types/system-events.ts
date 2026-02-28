import type { OutboundTriggerEventType } from './notification.js';

/** Event types received from external sources */
export type InboundEventType =
  | 'ci:completed'          // CI/CD pipeline succeeded
  | 'ci:failed'             // CI/CD pipeline failed
  | 'issue:closed'          // Issue was closed
  | 'pr:merged'             // Pull request was merged
  | 'pr:review_comment'     // PR review comment was posted
  | 'pr:changes_requested'  // PR changes requested
  | 'pr:comment';           // PR general comment posted

/** All system event types (inbound + outbound triggers) */
export type SystemEventType = InboundEventType | OutboundTriggerEventType;

/** Event sources */
export type EventSource =
  | 'github'    // GitHub webhooks
  | 'gitlab'    // GitLab webhooks
  | 'internal'; // Agent Console internal events

export interface SystemEventMetadata {
  /** Repository identifier (e.g., 'owner/repo') */
  repositoryName?: string;
  /** Branch name */
  branch?: string;
  /** URL to event details (for display) */
  url?: string;
  /** Commit SHA (used for CI completion aggregation) */
  commitSha?: string;
}

/**
 * System-wide event representing a meaningful occurrence.
 * Used for both inbound (external → internal) and outbound (internal → external) flows.
 */
export interface SystemEvent {
  /** Event type in format `entity:action`. */
  type: SystemEventType;
  /** Event source - WHERE the event originated. */
  source: EventSource;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Target session (if applicable) */
  sessionId?: string;
  /** Target worker (if applicable) */
  workerId?: string;
  /** Structured metadata for event routing and matching */
  metadata: SystemEventMetadata;
  /** Full event-specific payload (raw data from source) */
  payload: unknown;
  /** Human-readable summary */
  summary: string;
}

/** Inbound system event */
export type InboundSystemEvent = SystemEvent & { type: InboundEventType };

/** Intent classification for PTY notifications */
export type PtyNotificationIntent = 'triage' | 'inform';

/** Summary payload for WebSocket notifications */
export interface InboundEventSummary {
  type: InboundEventType;
  source: EventSource;
  summary: string;
  metadata: SystemEventMetadata;
}
