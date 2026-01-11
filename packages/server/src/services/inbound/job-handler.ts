import type { InboundEventType, SystemEvent } from '@agent-console/shared';
import { createLogger } from '../../lib/logger.js';
import type { InboundEventJobPayload } from '../../jobs/index.js';
import type { ServiceParser } from './service-parser.js';
import type { InboundEventHandler, EventTarget } from './handlers.js';
import { createInboundEventNotification } from '../../repositories/inbound-event-notification-repository.js';

const logger = createLogger('inbound-event-job');

const INBOUND_EVENT_TYPES: InboundEventType[] = [
  'ci:completed',
  'ci:failed',
  'issue:closed',
  'pr:merged',
];

function isInboundEventType(eventType: SystemEvent['type']): eventType is InboundEventType {
  return INBOUND_EVENT_TYPES.includes(eventType as InboundEventType);
}

export interface InboundEventJobDependencies {
  getServiceParser: (serviceId: string) => ServiceParser | null;
  resolveTargets: (event: SystemEvent) => Promise<EventTarget[]>;
  handlers: InboundEventHandler[];
}

export function createInboundEventJobHandler(deps: InboundEventJobDependencies) {
  return async (job: InboundEventJobPayload): Promise<void> => {
    const parser = deps.getServiceParser(job.service);
    if (!parser) {
      logger.warn({ service: job.service }, 'No service parser registered for inbound event');
      return;
    }

    const headers = new Headers(job.headers);

    let event: SystemEvent | null = null;
    try {
      event = await parser.parse(job.rawPayload, headers);
    } catch (error) {
      logger.warn({ err: error, service: job.service }, 'Failed to parse inbound event payload');
      return;
    }

    if (!event) {
      return;
    }

    const targets = await deps.resolveTargets(event);
    if (targets.length === 0) {
      logger.debug({ eventType: event.type }, 'No matching targets for inbound event');
      return;
    }

    const inboundEventType = event.type;
    if (!isInboundEventType(inboundEventType)) {
      logger.debug({ eventType: event.type }, 'Ignoring non-inbound event');
      return;
    }

    const handlers = deps.handlers.filter((handler) => handler.supportedEvents.includes(inboundEventType));
    if (handlers.length === 0) {
      logger.debug({ eventType: event.type }, 'No handlers registered for inbound event');
      return;
    }

    for (const target of targets) {
      for (const handler of handlers) {
        let handled = false;
        try {
          handled = await handler.handle(event, target);
        } catch (error) {
          logger.warn(
            { err: error, handlerId: handler.handlerId, sessionId: target.sessionId },
            'Inbound event handler failed'
          );
        }

        if (handled) {
          try {
            await createInboundEventNotification({
              id: crypto.randomUUID(),
              job_id: job.jobId,
              session_id: target.sessionId,
              worker_id: target.workerId ?? 'all',
              handler_id: handler.handlerId,
              event_type: event.type,
              event_summary: event.summary,
              notified_at: new Date().toISOString(),
            });
          } catch (error) {
            logger.warn(
              { err: error, handlerId: handler.handlerId, sessionId: target.sessionId },
              'Failed to record inbound event notification'
            );
          }
        }
      }
    }
  };
}
