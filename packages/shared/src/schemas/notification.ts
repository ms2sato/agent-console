import * as v from 'valibot';

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
export const RepositorySlackIntegrationInputSchema = v.object({
  webhookUrl: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Webhook URL is required'),
    v.regex(SLACK_WEBHOOK_URL_PATTERN, 'Must be a valid Slack webhook URL (https://hooks.slack.com/...)')
  ),
  enabled: v.optional(v.boolean(), true),
});

// === Inferred Types ===

export type RepositorySlackIntegrationInput = v.InferOutput<typeof RepositorySlackIntegrationInputSchema>;
