/**
 * Shared utilities for sending structured notifications to PTY processes.
 *
 * Used by both inbound event handlers and MCP tools to deliver
 * key=value formatted messages into agent worker terminals.
 */

import type { InboundEventType, PtyNotificationIntent } from '@agent-console/shared';

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
  kind: 'inbound-event';
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
  kind: 'internal-message';
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
  kind: 'internal-timer';
  tag: 'internal:timer';
  fields: {
    timerId: string;
    action: string;
    fireCount: string;
  };
  intent: PtyNotificationIntent;
}

export interface InternalReviewCommentPtyNotification extends BasePtyNotificationParams {
  kind: 'internal-review-comment';
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
  kind: 'internal-reviewed';
  tag: 'internal:reviewed';
  fields: {
    session: string;
    workerId: string;
    status: string;
    comments: string;
  };
  intent: PtyNotificationIntent;
}

export type WritePtyNotificationParams =
  | InboundEventPtyNotification
  | InternalMessagePtyNotification
  | InternalTimerPtyNotification
  | InternalReviewCommentPtyNotification
  | InternalReviewedPtyNotification;

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
  const { tag, fields, writeInput, intent } = params;
  const allFields: Record<string, string> = { timestamp: new Date().toISOString(), ...fields, intent };

  const fieldString = Object.entries(allFields)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(' ');

  const notification = `\n[${tag}] ${fieldString}`;
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
