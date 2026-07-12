import type { EmbeddedAgentDefinition } from '@agent-console/shared';
import { ConfirmDialog } from '../ui/confirm-dialog';
import type { EmbeddedAgentWorkerReference } from './findReferencingWorkers';

export interface EmbeddedAgentDeleteDialogProps {
  embeddedAgent: EmbeddedAgentDefinition | null;
  referencingWorkers: EmbeddedAgentWorkerReference[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

/**
 * Confirmation dialog for deleting an `EmbeddedAgentDefinition`. When live
 * workers still reference the definition, shows a warning list -- the
 * server allows the delete to proceed regardless (warn, not block), so the
 * confirm button still deletes.
 *
 * Presentational: data (the agent, the pre-computed reference list) is
 * passed in rather than computed via context, keeping this component
 * testable in isolation.
 */
export function EmbeddedAgentDeleteDialog({
  embeddedAgent,
  referencingWorkers,
  onOpenChange,
  onConfirm,
  isLoading = false,
}: EmbeddedAgentDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={embeddedAgent !== null}
      onOpenChange={onOpenChange}
      title="Delete Embedded Agent"
      description={`Are you sure you want to delete "${embeddedAgent?.name}"?`}
      confirmLabel="Delete"
      variant="danger"
      onConfirm={onConfirm}
      isLoading={isLoading}
    >
      {referencingWorkers.length > 0 && (
        <div className="text-sm text-amber-400 bg-amber-950/30 border border-amber-900 rounded p-3">
          <p className="font-medium mb-1">
            {referencingWorkers.length} worker{referencingWorkers.length === 1 ? '' : 's'} still reference this definition:
          </p>
          <ul className="list-disc list-inside">
            {referencingWorkers.map(({ session, worker }) => (
              <li key={worker.id}>
                &quot;{worker.name}&quot; in session &quot;{session.title ?? session.locationPath}&quot;
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {referencingWorkers.length === 1 ? 'This worker' : 'These workers'} will fail to activate
            after this definition is deleted. The delete will still proceed if you confirm.
          </p>
        </div>
      )}
    </ConfirmDialog>
  );
}
