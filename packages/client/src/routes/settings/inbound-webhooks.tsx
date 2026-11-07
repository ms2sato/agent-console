import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { fetchRepositories } from '../../lib/api';
import { repositoryKeys } from '../../lib/query-keys';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';
import { SecretRevealPanel } from '../../components/settings/SecretRevealPanel';
import { CreateEndpointForm } from '../../components/settings/CreateEndpointForm';
import { EndpointRow } from '../../components/settings/EndpointRow';
import {
  useInboundWebhookEndpointMutations,
  useInboundWebhookEndpointsQuery,
  type IssuedSecret,
} from '../../components/settings/hooks/useInboundWebhookEndpoints';

export const Route = createFileRoute('/settings/inbound-webhooks')({
  component: InboundWebhooksPage,
});

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function InboundWebhooksPage() {
  // The signing secret lives only here: never in a query cache, never persisted.
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [endpointToDelete, setEndpointToDelete] = useState<InboundWebhookEndpoint | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const endpointsQuery = useInboundWebhookEndpointsQuery();
  const repositoriesQuery = useQuery({ queryKey: repositoryKeys.all(), queryFn: fetchRepositories });
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const repositoryName = (id: string) => repositories.find((r) => r.id === id)?.name ?? id;

  const { create, rotate, update, remove, clearPrevious } = useInboundWebhookEndpointMutations(setIssued);

  const handleCreate = async (request: { label: string; repositoryId: string; instructionText: string }) => {
    try {
      await create.mutateAsync(request);
    } catch (err) {
      showError('Cannot Create Endpoint', errorMessage(err, 'Failed to create endpoint'));
      throw err;
    }
  };

  const handleRotate = async (endpoint: InboundWebhookEndpoint) => {
    try {
      await rotate.mutateAsync(endpoint.id);
    } catch (err) {
      showError('Cannot Rotate Secret', errorMessage(err, 'Failed to rotate secret'));
    }
  };

  const handleSave = async (id: string, changes: { label: string; instructionText: string }) => {
    try {
      await update.mutateAsync({ id, request: changes });
    } catch (err) {
      showError('Cannot Update Endpoint', errorMessage(err, 'Failed to update endpoint'));
      throw err;
    }
  };

  const handleClearPrevious = async (endpoint: InboundWebhookEndpoint) => {
    try {
      await clearPrevious.mutateAsync(endpoint.id);
    } catch (err) {
      showError('Cannot End Previous Secret', errorMessage(err, 'Failed to end previous secret'));
    }
  };

  const busy = rotate.isPending || update.isPending || remove.isPending || clearPrevious.isPending;
  const endpoints = endpointsQuery.data?.endpoints ?? [];

  let list: React.ReactNode;
  if (endpointsQuery.isLoading) {
    list = (
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading inbound webhook endpoints...</span>
      </div>
    );
  } else if (endpointsQuery.error) {
    list = (
      <div className="card text-center py-10">
        <p className="text-red-400 mb-4">Failed to load inbound webhook endpoints</p>
        <button onClick={() => endpointsQuery.refetch()} className="btn btn-primary">
          Retry
        </button>
      </div>
    );
  } else if (endpoints.length === 0) {
    list = (
      <div className="card text-center py-10">
        <p className="text-gray-500">No inbound webhook endpoints yet</p>
      </div>
    );
  } else {
    list = (
      <div className="flex flex-col gap-3">
        {endpoints.map((endpoint) => (
          <EndpointRow
            key={endpoint.id}
            endpoint={endpoint}
            repositoryName={repositoryName(endpoint.repositoryId)}
            busy={busy}
            onSave={handleSave}
            onRotate={handleRotate}
            onClearPrevious={handleClearPrevious}
            onDelete={setEndpointToDelete}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Settings', to: '/settings' },
        { label: 'Inbound Webhooks' },
      ]} />

      <h1 className="text-2xl font-semibold mb-2">Inbound Webhooks</h1>
      <p className="text-sm text-yellow-300 mb-6">Receiving is not active yet (in development).</p>

      {issued && (
        <SecretRevealPanel
          key={`${issued.endpointId}:${issued.secret}`}
          endpointLabel={issued.label}
          secret={issued.secret}
          onDismiss={() => setIssued(null)}
        />
      )}

      <CreateEndpointForm repositories={repositories} isPending={create.isPending} onSubmit={handleCreate} />

      {list}

      <ConfirmDialog
        open={endpointToDelete !== null}
        onOpenChange={(open) => !open && setEndpointToDelete(null)}
        title="Delete Inbound Webhook Endpoint"
        description={`Are you sure you want to delete "${endpointToDelete?.label}"? Senders using its secret will stop being accepted.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (!endpointToDelete) return;
          remove.mutate(endpointToDelete.id, {
            onSuccess: () => setEndpointToDelete(null),
            onError: (err) => {
              setEndpointToDelete(null);
              showError('Cannot Delete Endpoint', errorMessage(err, 'Failed to delete endpoint'));
            },
          });
        }}
        isLoading={remove.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
