import type { Repository, Session, SystemEvent } from '@agent-console/shared';
import type { EventTarget } from './handlers.js';
import { getOrgRepoFromPath as getOrgRepoFromPathDefault, GitError } from '../../lib/git.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('resolve-targets');

export interface TargetResolverDependencies {
  getSessions: () => Session[];
  getRepository: (repositoryId: string) => Repository | undefined;
  getOrgRepoFromPath?: (path: string) => Promise<string | null>;
}

/**
 * Determine if an error is expected (session doesn't match criteria) vs unexpected
 * (systemic issues like filesystem errors, git corruption).
 *
 * Expected errors are logged at debug level and processing continues.
 * Unexpected errors are logged at error level as they may indicate systemic issues.
 */
function isExpectedError(error: unknown): boolean {
  // GitError from git operations is expected - repository may not have
  // a remote configured, or path may be invalid
  return error instanceof GitError;
}

export async function resolveTargets(
  event: SystemEvent,
  deps: TargetResolverDependencies
): Promise<EventTarget[]> {
  const repositoryName = event.metadata.repositoryName;
  if (!repositoryName) {
    return [];
  }

  const sessions = deps.getSessions();
  const targets: EventTarget[] = [];
  const getOrgRepoFromPath = deps.getOrgRepoFromPath ?? getOrgRepoFromPathDefault;

  for (const session of sessions) {
    try {
      if (session.type !== 'worktree' || !session.repositoryId) continue;

      const repository = deps.getRepository(session.repositoryId);
      if (!repository) continue;

      const orgRepo = await getOrgRepoFromPath(repository.path);
      if (!orgRepo) continue;

      if (!isMatchingRepository(orgRepo, repositoryName)) {
        continue;
      }

      if (event.metadata.branch && session.worktreeId !== event.metadata.branch) {
        continue;
      }

      targets.push({ sessionId: session.id });
    } catch (error) {
      // Distinguish between expected errors (session doesn't match criteria)
      // and unexpected errors (filesystem issues, git corruption, etc.)
      if (isExpectedError(error)) {
        // Expected errors: session doesn't match, logged at debug level
        logger.debug(
          { err: error, sessionId: session.id, repositoryName },
          'Session does not match criteria for inbound event'
        );
      } else {
        // Unexpected errors: may indicate systemic issues, logged at error level
        logger.error(
          { err: error, sessionId: session.id, repositoryName },
          'Unexpected error resolving target for session'
        );
      }
      // Continue processing remaining sessions regardless of error type
    }
  }

  return targets;
}

function isMatchingRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
