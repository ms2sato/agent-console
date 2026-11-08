/**
 * Job handler for `inbound-webhook:process`: the only place that joins the receive half and an
 * action. It re-reads the endpoint into `DeliveryContent` (receive half), then hands it to the
 * action for the endpoint kind (today only the repository's designated Orchestrators).
 */
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import {
  deliverToRepositoryOrchestrators,
  type RepositoryOrchestratorsDeps,
} from './actions/repository-orchestrators.js';
import { prepareDelivery, type PrepareDeliveryDeps } from './receive.js';

export interface InboundWebhookJobDeps extends PrepareDeliveryDeps {
  action: RepositoryOrchestratorsDeps;
}

export function createInboundWebhookJobHandler(deps: InboundWebhookJobDeps) {
  return async (payload: InboundWebhookProcessPayload): Promise<void> => {
    const content = await prepareDelivery(payload, deps);
    await deliverToRepositoryOrchestrators(content, payload.receivedAt, deps.action);
  };
}
