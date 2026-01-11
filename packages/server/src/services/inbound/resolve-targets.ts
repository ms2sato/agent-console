import type { Repository, Session, SystemEvent } from '@agent-console/shared';
import type { EventTarget } from './handlers.js';
import { getOrgRepoFromPath as getOrgRepoFromPathDefault } from '../../lib/git.js';

export interface TargetResolverDependencies {
  getSessions: () => Session[];
  getRepository: (repositoryId: string) => Repository | undefined;
  getOrgRepoFromPath?: (path: string) => Promise<string | null>;
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
  }

  return targets;
}

function isMatchingRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
