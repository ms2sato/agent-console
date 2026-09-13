import type { Repository, Session, InboundSystemEvent } from '@agent-console/shared';
import type { EventTarget } from './handlers.js';
import { canDeliverToAgentWorker } from './handlers.js';
import { getOrgRepoFromPath as getOrgRepoFromPathDefault, GitError } from '../../lib/git.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('resolve-targets');

export interface TargetResolverDependencies {
  getSessions: () => Session[];
  getRepository: (repositoryId: string) => Repository | undefined;
  getAllRepositories: () => Repository[];
  getOrgRepoFromPath?: (path: string) => Promise<string | null>;
}

/**
 * Parse a comma-separated, case-insensitive trigger-label configuration
 * string into a normalized (lowercased, trimmed) set. Single writer: any
 * future consumer of `issueTriggerLabels` must call this rather than
 * re-splitting the string.
 */
export function parseTriggerLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

/** Does any of `eventLabels` match the repository's configured trigger labels? */
export function matchesAnyTriggerLabel(eventLabels: string[], triggerLabelsRaw: string | null | undefined): boolean {
  const configured = parseTriggerLabels(triggerLabelsRaw);
  if (configured.length === 0) return false; // vacuous-truth boundary: unset config never matches
  const normalizedEventLabels = eventLabels.map((l) => l.trim().toLowerCase());
  return normalizedEventLabels.some((l) => configured.includes(l));
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
  event: InboundSystemEvent,
  deps: TargetResolverDependencies
): Promise<EventTarget[]> {
  const repositoryName = event.metadata.repositoryName;
  if (!repositoryName) {
    return [];
  }

  const getOrgRepoFromPath = deps.getOrgRepoFromPath ?? getOrgRepoFromPathDefault;

  // `issue:labeled` never fans out to the repository's active sessions --
  // it routes exclusively to whichever session is flagged as the
  // repository's designated Orchestrator. Handled as an early return so
  // the per-session loop below (every other event type) is untouched.
  if (event.type === 'issue:labeled') {
    return resolveIssueLabeledTargets(event, deps, repositoryName, getOrgRepoFromPath);
  }

  const sessions = deps.getSessions();
  const targets: EventTarget[] = [];

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

      // Also notify the parent session (e.g., orchestrator)
      if (session.parentSessionId) {
        targets.push({ sessionId: session.parentSessionId });
      }
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

  // Deduplicate: a parent may appear multiple times if several children match
  const uniqueTargets = [...new Map(targets.map(t => [t.sessionId, t])).values()];
  return uniqueTargets;
}

function isMatchingRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Resolve targets for an `issue:labeled` event: find EVERY
 * locally-registered repository whose remote matches the webhook's
 * `repository.full_name` -- `RepositoryManager.registerRepository` only
 * rejects a duplicate PATH, not a duplicate git remote, so two independently
 * registered `Repository` rows (e.g. two clones of the same GitHub repo) can
 * legitimately resolve to the same remote. For each same-remote candidate,
 * check whether the event's label(s) match that repository's configured
 * `issueTriggerLabels` and it has a live designated Orchestrator session --
 * only then does it contribute a target. Unlike every other event type,
 * this never fans out across a repository's active sessions or notifies a
 * parent session.
 */
async function resolveIssueLabeledTargets(
  event: InboundSystemEvent,
  deps: TargetResolverDependencies,
  repositoryName: string,
  getOrgRepoFromPath: (path: string) => Promise<string | null>
): Promise<EventTarget[]> {
  const matchedRepositories: Repository[] = [];

  for (const repository of deps.getAllRepositories()) {
    try {
      const orgRepo = await getOrgRepoFromPath(repository.path);
      if (!orgRepo) continue;
      if (isMatchingRepository(orgRepo, repositoryName)) {
        matchedRepositories.push(repository);
      }
    } catch (error) {
      if (isExpectedError(error)) {
        logger.debug(
          { err: error, repositoryId: repository.id, repositoryName },
          'Repository does not match criteria for issue:labeled event'
        );
      } else {
        logger.error(
          { err: error, repositoryId: repository.id, repositoryName },
          'Unexpected error resolving repository for issue:labeled event'
        );
      }
    }
  }

  // `event.metadata.labels` is guaranteed present for `issue:labeled`
  // events by construction in the parser (github-service-parser.ts) --
  // TypeScript's `labels?: string[]` can't express "present iff type X".
  const eventLabels = event.metadata.labels ?? [];
  const sessions = deps.getSessions();

  // Evaluate eligibility (label match, then live-session lookup) for EVERY
  // same-remote candidate -- one ineligible candidate must never short-circuit
  // evaluation of the others. Dedup by session id: two same-remote
  // repositories could in principle designate the same session.
  const orchestratorSessionIds = new Set<string>();
  for (const repository of matchedRepositories) {
    if (!matchesAnyTriggerLabel(eventLabels, repository.issueTriggerLabels)) {
      logger.info(
        {
          repositoryId: repository.id,
          repositoryName,
          labels: eventLabels,
          issueTriggerLabels: repository.issueTriggerLabels,
        },
        "issue:labeled event did not match repository's configured trigger labels"
      );
      continue;
    }

    const orchestratorSessionId = repository.orchestratorSessionId;
    const liveSession = orchestratorSessionId
      ? sessions.find((s) => s.id === orchestratorSessionId)
      : undefined;

    if (!orchestratorSessionId || !liveSession) {
      logger.info(
        { repositoryId: repository.id, orchestratorSessionId },
        'issue:labeled event matched repository but no live orchestrator session is designated'
      );
      continue;
    }

    // The designated session existing in `getSessions()` is not enough --
    // a session survives there with `activationState: 'hibernated'` after
    // all its PTY workers have exited. Routing to a hibernated session would
    // silently drop the notification (nothing is listening) while still
    // reporting the event as delivered. `activationState` is already
    // computed upstream by `SessionConverterService.toPublicSession()`; read
    // it off `liveSession` rather than recomputing it here.
    if (liveSession.activationState !== 'running') {
      logger.info(
        { repositoryId: repository.id, orchestratorSessionId, activationState: liveSession.activationState },
        'issue:labeled event matched repository but the designated orchestrator session is not running'
      );
      continue;
    }

    // `activationState: 'running'` is computed vacuously true when the
    // session has zero agent/terminal-type workers (nothing to hibernate) --
    // e.g. a worktree session whose only worker is a `git-diff` worker. Such
    // a session passes the check above but AgentWorkerHandler.handle() can
    // never deliver to it (no `agent`-type worker to resolve a workerId
    // from). Check the same single-writer predicate handle() uses, so this
    // routing decision and the actual delivery capability never drift apart.
    if (!canDeliverToAgentWorker(liveSession)) {
      logger.info(
        { repositoryId: repository.id, orchestratorSessionId },
        'issue:labeled event matched repository but the designated orchestrator session has no agent worker to deliver to'
      );
      continue;
    }

    orchestratorSessionIds.add(orchestratorSessionId);
  }

  return [...orchestratorSessionIds].map((sessionId) => ({ sessionId }));
}
