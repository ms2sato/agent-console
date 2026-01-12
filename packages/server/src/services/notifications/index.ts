/**
 * Notification services for outbound integrations.
 *
 * Provides notification handlers and management for external service integration
 * (e.g., Slack notifications when agent state changes).
 */

import { NotificationManager } from './notification-manager.js';
import { SlackHandler } from './slack-handler.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('notification-services');

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

// Singleton instance
let notificationManager: NotificationManager | null = null;

/**
 * Initialize notification services.
 * Should be called once at server startup.
 */
export function initializeNotificationServices(): void {
  if (notificationManager) {
    return;
  }

  const slackHandler = new SlackHandler();
  notificationManager = new NotificationManager(slackHandler);
  logger.info('NotificationManager initialized');
}

/**
 * Get the NotificationManager instance.
 * Throws if services are not initialized.
 */
export function getNotificationManager(): NotificationManager {
  if (!notificationManager) {
    throw new Error('NotificationManager not initialized. Call initializeNotificationServices() first.');
  }
  return notificationManager;
}

/**
 * Shutdown notification services.
 * Should be called on server shutdown for cleanup.
 */
export function shutdownNotificationServices(): void {
  if (notificationManager) {
    notificationManager.dispose();
    notificationManager = null;
  }
}

/**
 * Set the NotificationManager singleton from an existing instance.
 * Used by AppContext to set the singleton without re-creating.
 * @internal For AppContext initialization only.
 */
export function setNotificationManager(instance: NotificationManager): void {
  if (notificationManager) {
    throw new Error('NotificationManager already initialized');
  }
  notificationManager = instance;
  logger.info('NotificationManager set from AppContext');
}
