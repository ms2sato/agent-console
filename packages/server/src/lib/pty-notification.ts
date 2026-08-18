/**
 * Shared utilities for sending structured notifications to PTY processes.
 *
 * Used by both inbound event handlers and MCP tools to deliver
 * key=value formatted messages into agent worker terminals.
 */

import type { InboundEventType, PtyNotificationIntent, PtyNotificationKind } from '@agent-console/shared';

/**
 * Sanitize and quote a string value for use in a key=value PTY notification field.
 *
 * - Strips terminal-interpreted control characters (C0, DEL, C1)
 * - Collapses whitespace into single spaces
 * - Quotes values containing spaces, equals signs, or double quotes
 */
export function formatFieldValue(value: string): string {
  // Strip control characters that terminals may interpret:
  // - ASCII C0 range (\x00-\x08, \x0e-\x1f) excluding whitespace (\x09 tab, \x0a LF, \x0d CR)
  // - DEL (\x7f)
  // - Unicode C1 range (\x80-\x9f) -- includes 8-bit CSI (U+009B) recognized by terminals in 8-bit mode
  // Whitespace controls are left for the \s+ normalization below to collapse into spaces.
  const sanitized = value.replace(/[\x00-\x08\x0e-\x1f\x7f\x80-\x9f]/g, '');
  const normalized = sanitized.replace(/\s+/g, ' ').trim();
  if (normalized.includes('"')) {
    return `"${normalized.replace(/"/g, '\\"')}"`;
  }
  if (normalized.includes(' ') || normalized.includes('=')) {
    return `"${normalized}"`;
  }
  return normalized;
}

interface BasePtyNotificationParams {
  /** Function to write data to the PTY */
  writeInput: (data: string) => void;
}

export interface InboundEventPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'inbound-event'>;
  tag: `inbound:${InboundEventType}`;
  fields: {
    type: InboundEventType;
    source: string;
    repo: string;
    branch: string;
    url: string;
    summary: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalMessagePtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-message'>;
  tag: 'internal:message';
  fields: {
    source: string;
    from: string;
    summary: string;
    path: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalTimerPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-timer'>;
  tag: 'internal:timer';
  fields: {
    timerId: string;
    action: string;
    fireCount: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalReviewCommentPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-review-comment'>;
  tag: 'internal:review-comment';
  fields: {
    session: string;
    file: string;
    line: string;
    body: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalReviewedPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-reviewed'>;
  tag: 'internal:reviewed';
  fields: {
    session: string;
    workerId: string;
    status: string;
    comments: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalProcessPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-process'>;
  tag: 'internal:process';
  fields: {
    processId: string;
    command: string;
    message: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalConditionalWakeupPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-conditional-wakeup'>;
  tag: 'internal:conditional-wakeup';
  fields: {
    wakeupId: string;
    status: string;
    checkCount: string;
    message: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalAgentSpawnFailedPtyNotification extends BasePtyNotificationParams {
  kind: Extract<PtyNotificationKind, 'internal-agent-spawn-failed'>;
  tag: 'internal:agent-spawn-failed';
  fields: {
    command: string;
    username: string;
    exitCode: string;
    diagnosis: string;
    remedy: string;
  };
  intent: PtyNotificationIntent;
}

export type WritePtyNotificationParams =
  | InboundEventPtyNotification
  | InternalMessagePtyNotification
  | InternalTimerPtyNotification
  | InternalReviewCommentPtyNotification
  | InternalReviewedPtyNotification
  | InternalProcessPtyNotification
  | InternalConditionalWakeupPtyNotification
  | InternalAgentSpawnFailedPtyNotification;

/**
 * Structured PTY-notification params, without the PTY-only `writeInput`
 * callback -- what {@link buildPtyNotificationText} accepts. Named alias
 * used by non-PTY delivery channels (e.g.
 * SessionManager.sendEmbeddedAgentSystemNotification) so callers don't
 * repeat the `Omit<WritePtyNotificationParams, 'writeInput'>` shape inline.
 */
export type PtyNotificationParams = Omit<WritePtyNotificationParams, 'writeInput'>;

/**
 * Build the structured notification text (`\n[tag] key1=val1 key2=val2
 * intent=...`) without writing it anywhere. Pure string-building extracted
 * from {@link writePtyNotification} so non-PTY delivery channels (e.g. an
 * embedded-agent worker's sendUserMessage) can reuse the exact same
 * notification template instead of duplicating it.
 */
export function buildPtyNotificationText(params: PtyNotificationParams): string {
  const { tag, fields, intent } = params;
  const allFields: Record<string, string> = { timestamp: new Date().toISOString(), ...fields, intent };

  const fieldString = Object.entries(allFields)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(' ');

  return `\n[${tag}] ${fieldString}`;
}

/**
 * Build and send a structured notification to a PTY process.
 *
 * Writes `\n[tag] key1=val1 key2=val2 intent=...` immediately, then sends
 * a carriage return (`\r`) after a 150ms delay so TUI agents can
 * process the text input before receiving the Enter keystroke.
 *
 * @returns The notification string that was written (without the trailing `\r`)
 */
export function writePtyNotification(params: WritePtyNotificationParams): string {
  const { writeInput } = params;
  const notification = buildPtyNotificationText(params);
  writeInput(notification);
  // Send Enter keystroke separately after a delay so TUI agents can process the text input first.
  // The PTY may have been disposed by the time the callback fires, so guard against errors.
  setTimeout(() => {
    try {
      writeInput('\r');
    } catch {
      // PTY may have been disposed; ignore
    }
  }, 150);

  return notification;
}

/**
 * Extract the `summary` field from a PTY notification's params, when the
 * kind's `fields` shape carries one (internal-message, inbound-event).
 * Used to populate EmbeddedAgentServerNotification.summary -- kinds
 * without a summary field legitimately produce `undefined` here; the
 * client falls back to the raw notification text in that case.
 */
export function extractNotificationSummary(params: PtyNotificationParams): string | undefined {
  const fields = params.fields as Record<string, string>;
  return typeof fields.summary === 'string' ? fields.summary : undefined;
}

/**
 * Build concise reply instructions appended to PTY notifications, so the
 * receiving agent knows how to respond via send_session_message. Single
 * writer of this block (both the PTY-write path in
 * mcp-server.ts and EmbeddedAgentWorkerService.sendSystemNotification
 * compose the delivered/persisted text via this helper).
 */
export function buildReplyInstructions(senderSessionId: string): string {
  const safeId = JSON.stringify(senderSessionId);
  return `\n[Reply Instructions] To reply, use the send_session_message MCP tool with:
- toSessionId: ${safeId}
- fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable`;
}
