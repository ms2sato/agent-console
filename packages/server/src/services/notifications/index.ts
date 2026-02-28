/**
 * Notification services for outbound integrations.
 *
 * Provides notification handlers and management for external service integration
 * (e.g., Slack notifications when agent state changes).
 */

export { SlackHandler } from './slack-handler.js';
export { NotificationManager } from './notification-manager.js';
export type { SessionExistsCallback } from './notification-manager.js';

// Repository-level Slack integration service
export {
  getByRepositoryId as getRepositorySlackIntegration,
  create as createRepositorySlackIntegration,
  update as updateRepositorySlackIntegration,
  upsert as upsertRepositorySlackIntegration,
  deleteIntegration as deleteRepositorySlackIntegration,
} from './repository-slack-integration-service.js';
