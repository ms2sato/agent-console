import * as v from 'valibot';

// This file is the OUTBOUND (Slack) notification system's schemas; the
// notification CENTER's wire schemas live in `notification-item.ts` — see
// `docs/design/notification-center.md` §7.

// === Repository Slack Integration Schema ===

/**
 * Pattern for validating Slack webhook URLs.
 * Must start with https://hooks.slack.com/
 */
const SLACK_WEBHOOK_URL_PATTERN = /^https:\/\/hooks\.slack\.com\//;

/**
 * Schema for creating/updating repository Slack integration.
 * Used by repository-specific Slack settings endpoints.
 */
export const RepositorySlackIntegrationInputSchema = v.strictObject({
  webhookUrl: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Webhook URL is required'),
    v.regex(SLACK_WEBHOOK_URL_PATTERN, 'Must be a valid Slack webhook URL (https://hooks.slack.com/...)')
  ),
  enabled: v.optional(v.boolean(), true),
});

/**
 * Schema for the repository Slack integration entity, the body of
 * `GET /api/repositories/:id/integrations/slack`. The field set mirrors
 * `RepositorySlackIntegration` in `types/notification.ts` (pinned in the schema test),
 * which the server still imports.
 */
export const RepositorySlackIntegrationSchema = v.strictObject({
  id: v.string(),
  repositoryId: v.string(),
  webhookUrl: v.string(),
  enabled: v.boolean(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Schema for `GET /api/settings/notifications/status`'s response. */
export const NotificationStatusResponseSchema = v.strictObject({
  baseUrl: v.string(),
  isBaseUrlConfigured: v.boolean(),
});

// === Inferred Types ===

export type RepositorySlackIntegrationInput = v.InferOutput<typeof RepositorySlackIntegrationInputSchema>;
export type NotificationStatus = v.InferOutput<typeof NotificationStatusResponseSchema>;
