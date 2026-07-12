import type { Session, EmbeddedAgentWorker } from '@agent-console/shared';

export interface EmbeddedAgentWorkerReference {
  session: Session;
  worker: EmbeddedAgentWorker;
}

/**
 * Finds all `embedded-agent` workers (across all sessions) that reference the
 * given `EmbeddedAgentDefinition`. Used to warn the user before deleting a
 * definition that live workers still depend on -- the server allows the
 * delete to proceed regardless (workers referencing a deleted definition
 * simply fail to activate afterward), so this is advisory, not blocking.
 */
export function findReferencingWorkers(
  sessions: Session[],
  embeddedAgentId: string
): EmbeddedAgentWorkerReference[] {
  return sessions.flatMap((session) =>
    session.workers
      .filter((worker): worker is EmbeddedAgentWorker =>
        worker.type === 'embedded-agent' && worker.embeddedAgentId === embeddedAgentId
      )
      .map((worker) => ({ session, worker }))
  );
}
