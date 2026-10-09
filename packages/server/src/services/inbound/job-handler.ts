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

/**
 * Whether `error` is the notifications table's FOREIGN KEY constraint
 * violation -- the permanent, per-target shape (a resolved target's
 * `sessionId` has no corresponding `sessions` row at all). Everything else
 * that can fail at the 'persist' step (a transient `SQLITE_BUSY`, an I/O
 * error, etc.) has NOT yet persisted anything for this unit of work, so it
 * must propagate and let the job queue retry -- swallowing it here would
 * silently drop the target instead of giving it a legitimate first-attempt
 * retry.
 */
function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // bun:sqlite sets `.code` on SQLiteError; fall back to the message text
  // in case a different driver or wrapping layer doesn't preserve it.
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error.message.includes('FOREIGN KEY constraint failed');
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
  markNotificationFailed: (
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
        // constraint on insert). `step` records which part of the unit of
        // work failed, for the catch block below: 'persist' means no
        // notification row exists yet (or we couldn't check) -- a target
        // with no DB row at all trips a permanent FK-constraint violation
        // here, everything else is transient and safe to retry from
        // scratch, since nothing has been persisted for this unit of work
        // yet. 'handle' means the pending row exists and `handler.handle()`
        // itself threw.
        //
        // There is deliberately no 'deliver' rethrow class. Both
        // `markNotificationDelivered` and `markNotificationFailed` writes
        // -- wherever they occur, after a resolved outcome or after a
        // 'handle'-step throw -- have their own try/catch and NEVER
        // rethrow. A job-level retry cannot tell apart "this pending row's
        // handler ran and should become delivered" from "...should become
        // failed": the only place that distinction was ever recorded is
        // the very write that just failed. Promoting it via a guess (the
        // idempotency branch below used to do this) risks silently
        // recording a known delivery failure as a successful delivery.
        // The safe outcome is to leave the row 'pending' and log which
        // terminal status it SHOULD have reached.
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
            if (existingNotification.status === 'delivered' || existingNotification.status === 'failed') {
              // Already a terminal status (delivered or failed) - skip
              // this handler/target combination. A 'failed' row is never
              // retried, same as 'delivered'.
              logger.debug(
                { jobId: job.jobId, sessionId: target.sessionId, handlerId: handler.handlerId, status: existingNotification.status },
                'Notification already at a terminal status, skipping handler'
              );
              continue;
            }
            // Status is 'pending' - a previous attempt started but its
            // outcome was never confirmed. The handler may have already
            // run, so it must NOT be re-invoked (at-most-once). Unlike
            // before, this is NOT administratively closed out as
            // 'delivered' -- that guess is exactly what let a KNOWN
            // delivery failure (a 'delivery-failed' outcome whose
            // markNotificationFailed write itself failed) get silently
            // recorded as a successful delivery on a later retry. Leave
            // the row 'pending' and log once so an operator can find it;
            // the warn/error line that created the pending-but-unconfirmed
            // row (the original markNotificationFailed failure, or a
            // handler.handle() throw) already named this target.
            logger.warn(
              { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId },
              'Pending notification from a previous attempt left unconfirmed; handler not re-invoked'
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
          const outcome = await handler.handle(event, target);

          // 'handled' and 'not-applicable' both mean the processing
          // attempt completed without a delivery failure (the old
          // boolean's "no action taken" case is 'not-applicable') -- the
          // intended terminal is 'delivered'. 'delivery-failed' means the
          // handler determined it should deliver and could not -- the
          // intended terminal is 'failed'. Either terminal write has its
          // own try/catch and never rethrows (see the comment above
          // `step`'s declaration) -- a bookkeeping write failure leaves
          // the row 'pending' and is logged with the terminal it should
          // have reached, never retried.
          if (outcome === 'delivery-failed') {
            try {
              await deps.notificationRepository.markNotificationFailed(
                job.jobId,
                target.sessionId,
                workerId,
                handler.handlerId
              );
              logger.warn(
                { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId, eventType: event.type },
                'Inbound notification delivery failed'
              );
            } catch (markFailedError) {
              logger.error(
                {
                  err: markFailedError,
                  jobId: job.jobId,
                  handlerId: handler.handlerId,
                  sessionId: target.sessionId,
                  workerId,
                  intendedTerminal: 'failed',
                },
                'Failed to mark notification as failed; row left pending'
              );
            }
          } else {
            try {
              await deps.notificationRepository.markNotificationDelivered(
                job.jobId,
                target.sessionId,
                workerId,
                handler.handlerId
              );

              if (outcome === 'handled') {
                logger.info(
                  { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId },
                  'Handler processed inbound event'
                );
              } else {
                logger.debug(
                  { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId },
                  'Handler skipped inbound event (not applicable)'
                );
              }
            } catch (markDeliveredError) {
              logger.error(
                {
                  err: markDeliveredError,
                  jobId: job.jobId,
                  handlerId: handler.handlerId,
                  sessionId: target.sessionId,
                  workerId,
                  intendedTerminal: 'delivered',
                },
                'Failed to mark notification as delivered; row left pending'
              );
            }
          }
        } catch (error) {
          // Exactly one rethrow class remains: a 'persist'-step failure
          // that is NOT a foreign-key-constraint violation has not
          // persisted anything for this unit of work yet (the idempotency
          // read or the insert itself failed transiently, e.g.
          // SQLITE_BUSY or an I/O error) -- rethrow so the job queue
          // retries it as a legitimate first attempt, rather than
          // silently dropping the target. A genuinely dangling sessionId
          // (an FK-constraint violation) at 'persist' is logged and
          // skipped, unchanged. There is no 'deliver' rethrow class (see
          // the comment above `step`'s declaration) -- every terminal
          // write, wherever it occurs, has its own try/catch and never
          // reaches here.
          if (step === 'persist' && !isForeignKeyConstraintError(error)) {
            throw error;
          }

          if (step === 'handle') {
            try {
              await deps.notificationRepository.markNotificationFailed(
                job.jobId,
                target.sessionId,
                workerId,
                handler.handlerId
              );
              logger.warn(
                { jobId: job.jobId, handlerId: handler.handlerId, sessionId: target.sessionId, workerId, eventType: event.type },
                'Inbound notification delivery failed'
              );
            } catch (markFailedError) {
              logger.error(
                {
                  err: markFailedError,
                  jobId: job.jobId,
                  handlerId: handler.handlerId,
                  sessionId: target.sessionId,
                  workerId,
                  intendedTerminal: 'failed',
                },
                'Failed to mark notification as failed after handler threw; row left pending'
              );
            }
          }

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
