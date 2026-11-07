/**
 * Job handler for `inbound-webhook:process`: the only place that joins the receive half and an
 * action. It re-reads the endpoint into `DeliveryContent` (receive half), then hands it to the
 * action for the endpoint kind (today only the repository's designated Orchestrators).
 */
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import { createLogger } from '../../lib/logger.js';
import { PermanentHandlerError } from '../inbound/job-handler.js';
import {
  deliverToRepositoryOrchestrators,
  type RepositoryOrchestratorsDeps,
} from './actions/repository-orchestrators.js';
import { prepareDelivery, type PrepareDeliveryDeps } from './receive.js';

const logger = createLogger('inbound-webhook-job');

export interface InboundWebhookJobDeps extends PrepareDeliveryDeps {
  action: RepositoryOrchestratorsDeps;
}

export function createInboundWebhookJobHandler(deps: InboundWebhookJobDeps) {
  return async (payload: InboundWebhookProcessPayload): Promise<void> => {
    let content;
    try {
      content = await prepareDelivery(payload, deps);
    } catch (error) {
      // The job queue retries any throw, and a deleted endpoint or a payload that no longer
      // parses can never succeed on retry. End the job here instead of letting it retry to a stall.
      if (error instanceof PermanentHandlerError) {
        logger.warn(
          { jobId: payload.jobId, endpointId: payload.endpointId, reason: error.message },
          'Inbound webhook job ended without delivery',
        );
        return;
      }
      throw error;
    }
    await deliverToRepositoryOrchestrators(content, payload.receivedAt, deps.action);
  };
}
