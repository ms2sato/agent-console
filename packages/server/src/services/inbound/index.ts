import type { JobQueue } from '../../jobs/index.js';
import { JOB_TYPES } from '../../jobs/index.js';
import type { SessionManager } from '../session-manager.js';
import type { RepositoryManager } from '../repository-manager.js';
import type { InboundEventSummary } from '@agent-console/shared';
import { GitHubServiceParser } from './github-service-parser.js';
import { createInboundEventJobHandler } from './job-handler.js';
import { createInboundHandlers } from './handlers.js';
import { getServiceParser, registerServiceParser } from './parser-registry.js';
import { resolveTargets as resolveTargetsImpl } from './resolve-targets.js';

let inboundInitialized = false;

export interface InboundIntegrationOptions {
  jobQueue: JobQueue;
  sessionManager: SessionManager;
  repositoryManager: RepositoryManager;
  broadcastToApp: (message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => void;
}

export function initializeInboundIntegration(options: InboundIntegrationOptions): void {
  if (inboundInitialized) {
    return;
  }
  inboundInitialized = true;

  registerServiceParser(new GitHubServiceParser());

  const handlers = createInboundHandlers({
    sessionManager: options.sessionManager,
    broadcastToApp: options.broadcastToApp,
  });

  const resolveTargets = (event: Parameters<typeof resolveTargetsImpl>[0]) =>
    resolveTargetsImpl(event, {
      getSessions: () => options.sessionManager.getAllSessions(),
      getRepository: (repositoryId) => options.repositoryManager.getRepository(repositoryId),
    });

  options.jobQueue.registerHandler(
    JOB_TYPES.INBOUND_EVENT_PROCESS,
    createInboundEventJobHandler({
      getServiceParser,
      resolveTargets,
      handlers,
    })
  );
}
