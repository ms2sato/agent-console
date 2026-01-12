import type { JobQueue } from '../../jobs/index.js';
import { JOB_TYPES } from '../../jobs/index.js';
import type { SessionManager } from '../session-manager.js';
import type { RepositoryManager } from '../repository-manager.js';
import type { InboundEventSummary } from '@agent-console/shared';
import { GitHubServiceParser } from './github-service-parser.js';
import { createInboundEventJobHandler } from './job-handler.js';
import { createInboundHandlers } from './handlers.js';
import { ServiceParserRegistry } from './parser-registry.js';
import { resolveTargets as resolveTargetsImpl } from './resolve-targets.js';

export interface InboundIntegrationOptions {
  jobQueue: JobQueue;
  sessionManager: SessionManager;
  repositoryManager: RepositoryManager;
  broadcastToApp: (message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => void;
  /** Optional registry instance for testing. If not provided, a new registry is created. */
  parserRegistry?: ServiceParserRegistry;
}

/**
 * Result of initializing inbound integration.
 * Contains the parser registry for accessing service parsers.
 */
export interface InboundIntegrationInstance {
  /** The parser registry used by this integration instance */
  parserRegistry: ServiceParserRegistry;
}

/**
 * Initialize inbound integration with dependency injection.
 *
 * This function no longer uses global state. Each call creates a fresh integration
 * instance, making it suitable for use in tests without state pollution.
 *
 * @returns An instance containing the parser registry for accessing service parsers
 */
export function initializeInboundIntegration(options: InboundIntegrationOptions): InboundIntegrationInstance {
  const parserRegistry = options.parserRegistry ?? new ServiceParserRegistry();

  parserRegistry.register(new GitHubServiceParser());

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
      getServiceParser: (serviceId) => parserRegistry.get(serviceId),
      resolveTargets,
      handlers,
    })
  );

  return { parserRegistry };
}
