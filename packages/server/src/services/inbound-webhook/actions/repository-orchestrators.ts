/**
 * Action half of the generic inbound webhook for the only endpoint kind: deliver a message to the
 * designated Orchestrator sessions of the endpoint's repository.
 *
 * It turns the receive half's `DeliveryContent` into an `external:message` event and hands it to
 * the existing inbound-event pipeline (`createInboundEventJobHandler`: target resolution, the
 * notification ledger, the handlers). The one thing it adds around that pipeline is the two
 * per-target files (`body.md`, `instruction.md` and the `attachments/` copies), written BEFORE the targets are returned and so
 * before any notification names them.
 */
import type { InboundSystemEvent, Repository, Session } from '@agent-console/shared';
import { getOrgRepoFromPath as getOrgRepoFromPathDefault } from '../../../lib/git.js';
import { toInstructionExcerpt } from '../../../lib/inbound-instruction-excerpt.js';
import { createLogger } from '../../../lib/logger.js';
import type { SessionDataPathResolver } from '../../../lib/session-data-path-resolver.js';
import { writeFileInTrustedDir } from '../../../lib/trusted-file-write.js';
import { findDeliverableWorkerId, type EventTarget, type InboundEventHandler } from '../../inbound/handlers.js';
import {
  createInboundEventJobHandler,
  type InboundEventNotificationRepository,
} from '../../inbound/job-handler.js';
import type { ServiceParser } from '../../inbound/service-parser.js';
import type { SessionManager } from '../../session-manager.js';
import type { DeliveryContent } from '../receive.js';

const logger = createLogger('inbound-webhook-orchestrators');

const SERVICE_ID = 'inbound-webhook';

/** A target session as the delivery sees it: the session and where its data files live. */
export interface DeliverySession {
  session: Session;
  resolver: SessionDataPathResolver;
}

export interface RepositoryOrchestratorsDeps {
  getRepository: (repositoryId: string) => Repository | undefined;
  /** Remote slug (`owner/repo`) of a registered repository, for display. Defaults to the git helper. */
  getOrgRepoFromPath?: (path: string) => Promise<string | null>;
  /** The real target resolution (`resolveTargets`); this module wraps it, it does not replace it. */
  resolveTargets: (event: InboundSystemEvent) => Promise<EventTarget[]>;
  /** The target session and its data path resolver, live or paused; null when it is neither. */
  lookupDeliverySession: (sessionId: string) => Promise<DeliverySession | null>;
  handlers: InboundEventHandler[];
  notificationRepository: InboundEventNotificationRepository;
}

type DeliverySessionManager = Pick<
  SessionManager,
  'getSession' | 'getPathResolverForSessionId' | 'resolvePausedMessageTarget'
>;

/** Wiring helper: the live session first, otherwise the paused one (the same order the handler uses). */
export function createDeliverySessionLookup(
  sessionManager: DeliverySessionManager,
): RepositoryOrchestratorsDeps['lookupDeliverySession'] {
  return async (sessionId) => {
    const live = sessionManager.getSession(sessionId);
    if (live) {
      const resolver = sessionManager.getPathResolverForSessionId(sessionId);
      return resolver ? { session: live, resolver } : null;
    }
    return sessionManager.resolvePausedMessageTarget(sessionId);
  };
}

async function displaySlug(repository: Repository, deps: RepositoryOrchestratorsDeps): Promise<string> {
  const getOrgRepoFromPath = deps.getOrgRepoFromPath ?? getOrgRepoFromPathDefault;
  try {
    return (await getOrgRepoFromPath(repository.path)) ?? repository.name;
  } catch (error) {
    logger.debug({ err: error, repositoryId: repository.id }, 'Could not read the remote slug; using the repository name');
    return repository.name;
  }
}

/**
 * Copy the one in-memory set of fetched attachments into this target's `attachments/` directory.
 * Best effort per file: a file that cannot be written is skipped for this target only (logged with
 * ids and the file's position, never its name), and neither the target nor the body is affected.
 * The event-level counts are not changed by such a failure.
 */
async function writeAttachments(
  resolver: SessionDataPathResolver,
  sessionId: string,
  workerId: string,
  content: DeliveryContent,
): Promise<void> {
  const root = resolver.getTrustedRoot();
  for (const [index, attachment] of content.attachments.entries()) {
    try {
      const filePath = resolver.getInboundWebhookAttachmentPath(sessionId, workerId, content.deliveryId, attachment.name);
      await writeFileInTrustedDir(root, filePath, attachment.bytes);
    } catch (error) {
      logger.warn(
        { sessionId, workerId, deliveryId: content.deliveryId, index, errorName: error instanceof Error ? error.name : 'unknown' },
        'Failed to write an inbound webhook attachment for a target; skipped for this target',
      );
    }
  }
}

/**
 * Write the delivery files into the target's own directory and return the target pinned to the
 * worker the notification will go to. Null (logged, no content) when this target cannot be
 * prepared; it is then left out of the delivery and the others proceed.
 */
async function prepareTarget(
  target: EventTarget,
  content: DeliveryContent,
  deps: RepositoryOrchestratorsDeps,
): Promise<EventTarget | null> {
  const { sessionId } = target;
  try {
    const found = await deps.lookupDeliverySession(sessionId);
    const workerId = found ? (target.workerId ?? findDeliverableWorkerId(found.session)) : undefined;
    if (!found || !workerId) {
      logger.warn({ sessionId, deliveryId: content.deliveryId }, 'Inbound webhook target has no deliverable worker; dropped');
      return null;
    }
    const paths = found.resolver.getInboundWebhookDeliveryPaths(sessionId, workerId, content.deliveryId);
    const root = found.resolver.getTrustedRoot();
    await writeFileInTrustedDir(root, paths.bodyPath, content.bodyMarkdown);
    await writeFileInTrustedDir(root, paths.instructionPath, content.instructionMarkdown);
    await writeAttachments(found.resolver, sessionId, workerId, content);
    return { ...target, workerId };
  } catch (error) {
    logger.error(
      { err: error, sessionId, deliveryId: content.deliveryId },
      'Failed to write the inbound webhook delivery files for a target; target dropped',
    );
    return null;
  }
}

/**
 * Deliver one message to the designated Orchestrator sessions of the endpoint's repository.
 * `jobId` for the pipeline is the delivery id, so the notification ledger
 * (job id + session + worker + handler) makes a retried job skip targets already notified.
 */
export async function deliverToRepositoryOrchestrators(
  content: DeliveryContent,
  receivedAt: string,
  deps: RepositoryOrchestratorsDeps,
): Promise<void> {
  const repository = deps.getRepository(content.endpoint.repositoryId);
  if (!repository) {
    logger.warn(
      { endpointId: content.endpoint.id, repositoryId: content.endpoint.repositoryId },
      'Inbound webhook endpoint repository is not registered; nothing delivered',
    );
    return;
  }

  const event: InboundSystemEvent = {
    type: 'external:message',
    source: 'webhook',
    timestamp: receivedAt,
    metadata: {
      targetRepositoryId: repository.id,
      repositoryName: await displaySlug(repository, deps),
      deliveryId: content.deliveryId,
      instructionExcerpt: toInstructionExcerpt(content.instructionMarkdown),
      url: content.url ?? undefined,
      // Event-level counts from the one fetch. A per-target write failure does not change them.
      ...(content.hasAttachments
        ? { attachmentsFetched: content.attachmentsFetched, attachmentsSkipped: content.attachmentsSkipped }
        : {}),
    },
    payload: {},
    summary: content.summary,
  };

  // Stands in for a service parser: the event is already built, so `parse` returns it. It is
  // local to this call and is not registered in the parser registry.
  const prebuiltEventParser: ServiceParser = {
    serviceId: SERVICE_ID,
    authenticate: async () => false,
    parse: async () => event,
  };

  const handleJob = createInboundEventJobHandler({
    getServiceParser: (serviceId) => (serviceId === SERVICE_ID ? prebuiltEventParser : null),
    resolveTargets: async (resolvedEvent) => {
      const targets = await deps.resolveTargets(resolvedEvent);
      const prepared: EventTarget[] = [];
      for (const target of targets) {
        const ready = await prepareTarget(target, content, deps);
        if (ready) prepared.push(ready);
      }
      return prepared;
    },
    handlers: deps.handlers,
    notificationRepository: deps.notificationRepository,
  });

  await handleJob({ jobId: content.deliveryId, service: SERVICE_ID, rawPayload: '', headers: {}, receivedAt });
}
