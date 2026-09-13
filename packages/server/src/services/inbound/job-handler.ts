import type {
  InboundSystemEvent,
} from '@agent-console/shared';
import { createLogger } from '../../lib/logger.js';
import type { InboundEventJobPayload } from '../../jobs/index.js';
import type { InboundEventNotification, NewInboundEventNotification } from '../../database/schema.js';
import type { ServiceParser } from './service-parser.js';
import type { InboundEventHandler, EventTarget } from './handlers.js';
import type { CICompletionChecker } from './ci-completion-checker.js';

const logger = createLogger('inbound-event-job');

/**
 * Error indicating a permanent failure that should not be retried.
 *
 * Use this for errors like:
 * - Invalid payload that will never parse successfully
 * - Unknown event types that won't become known after retry
 * - Database schema violations
 */
export class PermanentHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentHandlerError';
  }
}

export interface InboundEventJobDependencies {
  getServiceParser: (serviceId: string) => ServiceParser | null;
  resolveTargets: (event: InboundSystemEvent) => Promise<EventTarget[]>;
  handlers: InboundEventHandler[];
  notificationRepository: InboundEventNotificationRepository;
  /** When provided, ci:completed events are held until all workflows for the commit SHA have succeeded. */
  ciCompletionChecker?: CICompletionChecker;
}

export interface InboundEventNotificationRepository {
  findInboundEventNotification: (
    jobId: string,
    sessionId: string,
    workerId: string,
    handlerId: string
  ) => Promise<InboundEventNotification | null>;
  createPendingNotification: (
    notification: Omit<NewInboundEventNotification, 'status' | 'notified_at'>
  ) => Promise<void>;
  markNotificationDelivered: (
    jobId: string,
    sessionId: string,
    workerId: string,
    handlerId: string
  ) => Promise<void>;
}

export function createInboundEventJobHandler(deps: InboundEventJobDependencies) {
  return async (job: InboundEventJobPayload): Promise<void> => {
    const parser = deps.getServiceParser(job.service);
    if (!parser) {
      // No parser registered - this is a permanent error (won't be fixed by retry)
      throw new PermanentHandlerError(`No service parser registered for service: ${job.service}`);
    }

    const headers = new Headers(job.headers);

    let event: InboundSystemEvent | null = null;
    try {
      event = await parser.parse(job.rawPayload, headers);
    } catch (error) {
      // Parse failure is permanent - the payload won't change on retry
      const message = error instanceof Error ? error.message : String(error);
      throw new PermanentHandlerError(`Failed to parse inbound event payload: ${message}`);
    }

    if (!event) {
      // Parser returned null - event is not of interest, complete successfully
      logger.debug({ service: job.service }, 'Parser returned null, event not of interest');
      return;
    }

    const targets = await deps.resolveTargets(event);
    if (targets.length === 0) {
      // No targets - complete successfully (not an error condition)
      logger.debug({ eventType: event.type }, 'No matching targets for inbound event');
      return;
    }

    // --- CI completion aggregation gate ---
    if (event.type === 'ci:completed' && deps.ciCompletionChecker) {
      const { repositoryName, commitSha, branch } = event.metadata;
      if (repositoryName && commitSha) {
        const result = await deps.ciCompletionChecker(repositoryName, commitSha, branch);
        if (result !== null) {
          if (!result.allCompleted) {
            logger.info(
              {
                eventType: event.type,
                repositoryName,
                commitSha,
                branch,
                successCount: result.successCount,
                totalWorkflows: result.totalWorkflows,
              },
              'CI completion suppressed: not all workflows finished'
            );
            return; // Suppress — wait for remaining workflows
          }
          // All workflows completed successfully — update summary
          event = {
            ...event,
            summary: `All CI workflows passed (${result.workflowNames.join(', ')})`,
          };
        }
        // result === null: fail-open, proceed with original event
      }
    }

    const handlers = deps.handlers.filter((handler) => handler.supportedEvents.includes(event.type));
    if (handlers.length === 0) {
      // No handlers - complete successfully
      logger.debug({ eventType: event.type }, 'No handlers registered for inbound event');
      return;
    }

    for (const target of targets) {
      for (const handler of handlers) {
        const workerId = target.workerId ?? 'all';

        // Isolate this target/handler unit of work: a failure resolving,
        // persisting, or dispatching for one target must not block other
        // targets or fail the whole job (e.g. a target whose session row no
        // longer exists trips the notifications table's FOREIGN KEY
        // constraint on insert). `step` records which half of the unit of
        // work failed, for the catch block below: 'persist' means no
        // notification row exists (or we couldn't check), 'handle' means
        // the row was already created and stays pending.
        let step: 'persist' | 'handle' = 'persist';
        try {
          // IDEMPOTENCY CHECK: Skip if notification already exists (delivered or pending)
          // This prevents duplicate handler execution on job retry
          const existingNotification = await deps.notificationRepository.findInboundEventNotification(
            job.jobId,
            target.sessionId,
            workerId,
            handler.handlerId
          );

          if (existingNotification) {
            if (existingNotification.status === 'delivered') {
              // Already delivered - skip this handler/target combination
              logger.debug(
                { jobId: job.jobId, sessionId: target.sessionId, handlerId: handler.handlerId },
                'Notification already delivered, skipping handler'
              );
              continue;
            }
            // Status is 'pending' - previous attempt started but didn't complete
            // The handler may have already executed, so we should NOT retry the handler
            // Just mark it as delivered to complete the job
            logger.debug(
              { jobId: job.jobId, sessionId: target.sessionId, handlerId: handler.handlerId },
              'Found pending notification from previous attempt, marking as delivered'
            );
            await deps.notificationRepository.markNotificationDelivered(
              job.jobId,
              target.sessionId,
              workerId,
              handler.handlerId
            );
            continue;
          }

          // ATOMIC SAFETY: Create pending notification BEFORE handler execution
          // This ensures that if handler succeeds but update fails, we don't retry the handler
          const notificationId = crypto.randomUUID();
          await deps.notificationRepository.createPendingNotification({
            id: notificationId,
            job_id: job.jobId,
            session_id: target.sessionId,
            worker_id: workerId,
            handler_id: handler.handlerId,
            event_type: event.type,
            event_summary: event.summary,
            created_at: new Date().toISOString(),
          });

          step = 'handle';
          const handled = await handler.handle(event, target);

          // Always mark notification as delivered after handler completes
          // Handler returning false means "no action taken" (e.g., session not found),
          // not "failed" - we still want to prevent retry
          await deps.notificationRepository.markNotificationDelivered(
            job.jobId,
            target.sessionId,
            workerId,
            handler.handlerId
          );

          if (handled) {
            logger.info(
              { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId },
              'Handler processed inbound event'
            );
          } else {
            logger.debug(
              { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId },
              'Handler skipped inbound event (returned false)'
            );
          }
        } catch (error) {
          logger.error(
            {
              err: error,
              step,
              jobId: job.jobId,
              handlerId: handler.handlerId,
              sessionId: target.sessionId,
              workerId,
              eventType: event.type,
              eventSummary: event.summary,
            },
            'Failed to process inbound event notification for target; skipping'
          );
        }
      }
    }
  };
}
