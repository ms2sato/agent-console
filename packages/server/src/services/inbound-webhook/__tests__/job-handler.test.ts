import { describe, it, expect, mock } from 'bun:test';
import type { InboundWebhookProcessPayload } from '@agent-console/shared';
import { createInboundWebhookJobHandler } from '../job-handler.js';
import { PermanentHandlerError } from '../../../jobs/index.js';
import { inboundWebhookDeliveryId } from '../receive.js';
import type { RepositoryOrchestratorsDeps } from '../actions/repository-orchestrators.js';

const PAYLOAD: InboundWebhookProcessPayload = {
  jobId: inboundWebhookDeliveryId('ep-1', 'wh-1'),
  endpointId: 'ep-1',
  rawPayload: JSON.stringify({ message: 'hello' }),
  receivedAt: '2026-11-08T00:00:00.000Z',
};

function endpointRow(repositoryId: string) {
  return { id: 'ep-1', repositoryId, label: 'Slack', instructionText: 'Do it\n', secret: 's', previousSecret: null, previousSecretExpiresAt: null, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' };
}

/** An action whose repository is unknown: delivery returns at once, and records that it was reached. */
function actionDeps(): { action: RepositoryOrchestratorsDeps; getRepository: ReturnType<typeof mock> } {
  const getRepository = mock(() => undefined);
  return {
    getRepository,
    action: {
      getRepository,
      resolveTargets: async () => [],
      lookupDeliverySession: async () => null,
      handlers: [],
      notificationRepository: {
        findInboundEventNotification: async () => null,
        createPendingNotification: async () => {},
        markNotificationDelivered: async () => {},
        markNotificationFailed: async () => {},
      },
    },
  };
}

describe('createInboundWebhookJobHandler', () => {
  it('hands the re-read delivery content to the action', async () => {
    const { action, getRepository } = actionDeps();
    const handler = createInboundWebhookJobHandler({
      endpoints: { findWithSecretById: async () => endpointRow('repo-9') },
      action,
    });
    await handler(PAYLOAD);
    expect(getRepository).toHaveBeenCalledWith('repo-9');
  });

  it('a missing endpoint throws PermanentHandlerError and never reaches the action', async () => {
    const { action, getRepository } = actionDeps();
    const handler = createInboundWebhookJobHandler({ endpoints: { findWithSecretById: async () => null }, action });
    await expect(handler(PAYLOAD)).rejects.toBeInstanceOf(PermanentHandlerError);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('a stored payload that no longer parses throws PermanentHandlerError the same way', async () => {
    const { action, getRepository } = actionDeps();
    const handler = createInboundWebhookJobHandler({
      endpoints: { findWithSecretById: async () => endpointRow('repo-9') },
      action,
    });
    await expect(handler({ ...PAYLOAD, rawPayload: '{broken' })).rejects.toBeInstanceOf(PermanentHandlerError);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('any other failure propagates so the queue retries it', async () => {
    const { action } = actionDeps();
    const handler = createInboundWebhookJobHandler({
      endpoints: { findWithSecretById: async () => { throw new Error('database busy'); } },
      action,
    });
    await expect(handler(PAYLOAD)).rejects.toThrow('database busy');
  });
});
