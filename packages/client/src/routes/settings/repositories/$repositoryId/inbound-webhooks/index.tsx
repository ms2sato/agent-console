import { useState } from 'react';
import { createFileRoute, Link, type ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { InboundWebhookEndpoint } from '@agent-console/shared';
import { fetchRepository } from '../../../../../lib/api';
import { repositoryKeys } from '../../../../../lib/query-keys';
import { PageBreadcrumb } from '../../../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../../../components/PageErrorFallback';
import { ConfirmDialog } from '../../../../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../../../../components/ui/error-dialog';
import { Spinner } from '../../../../../components/ui/Spinner';
import { SecretRevealPanel } from '../../../../../components/settings/SecretRevealPanel';
import { EndpointRow } from '../../../../../components/settings/EndpointRow';
import { RotateSecretDialog } from '../../../../../components/settings/RotateSecretDialog';
import {
  useInboundWebhookEndpointMutations,
  useInboundWebhookEndpointsQuery,
  type IssuedSecret,
  type TakeSecret,
} from '../../../../../components/settings/hooks/useInboundWebhookEndpoints';

export const Route = createFileRoute('/settings/repositories/$repositoryId/inbound-webhooks/')({
  component: InboundWebhooksListPage,
  pendingComponent: InboundWebhooksListPending,
  errorComponent: InboundWebhooksListError,
});

export function InboundWebhooksListPending() {
  return <PagePendingFallback message="Loading repository..." />;
}

export function InboundWebhooksListError({ error, reset }: ErrorComponentProps) {
  return (
    <PageErrorFallback
      error={error}
      reset={reset}
      breadcrumbItems={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: 'Error' },
      ]}
      errorMessage="Failed to load repository"
      backTo="/settings/repositories"
      backLabel="Back to Repositories"
    />
  );
}

function InboundWebhooksListPage() {
  const { repositoryId } = Route.useParams();
  return <InboundWebhooksListView repositoryId={repositoryId} />;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Presentational view of the list page, exported so tests can mount it without
 * the route tree (production goes through `InboundWebhooksListPage`).
 */
export function InboundWebhooksListView({ repositoryId }: { repositoryId: string }) {
  // A generated signing secret lives only here: never in a query cache, never persisted.
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [rotateTarget, setRotateTarget] = useState<InboundWebhookEndpoint | null>(null);
  const [endpointToDelete, setEndpointToDelete] = useState<InboundWebhookEndpoint | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data: repositoryData } = useSuspenseQuery({
    queryKey: repositoryKeys.detail(repositoryId),
    queryFn: () => fetchRepository(repositoryId),
  });
  const repository = repositoryData.repository;

  const endpointsQuery = useInboundWebhookEndpointsQuery(repositoryId);
  const { rotate, remove, clearPrevious, rotateSecret } = useInboundWebhookEndpointMutations(repositoryId, setIssued);

  // An issued secret is shown once: no second rotate may replace it before it is saved.
  const rotateBlocked = rotate.isPending || issued !== null;
  const busy = remove.isPending || clearPrevious.isPending;

  const handleRotate = async (endpoint: InboundWebhookEndpoint, takeSecret?: TakeSecret) => {
    setRotateTarget(null);
    try {
      await rotateSecret({ endpoint, takeSecret });
    } catch (err) {
      showError('Cannot Rotate Secret', errorMessage(err, 'Failed to rotate secret'));
    }
  };

  const handleClearPrevious = async (endpoint: InboundWebhookEndpoint) => {
    try {
      await clearPrevious.mutateAsync(endpoint.id);
    } catch (err) {
      showError('Cannot End Previous Secret', errorMessage(err, 'Failed to end previous secret'));
    }
  };

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
            repositoryId={repositoryId}
            endpoint={endpoint}
            busy={busy}
            rotateBlocked={rotateBlocked}
            onRotate={setRotateTarget}
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
        { label: 'Repositories', to: '/settings/repositories' },
        { label: repository.name, to: '/settings/repositories/$repositoryId', params: { repositoryId } },
        { label: 'Inbound Webhooks' },
      ]} />

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Inbound Webhooks</h1>
        <Link
          to="/settings/repositories/$repositoryId/inbound-webhooks/new"
          params={{ repositoryId }}
          className="btn btn-primary text-sm no-underline"
        >
          New endpoint
        </Link>
      </div>

      {issued && (
        <SecretRevealPanel
          endpointLabel={issued.label}
          secret={issued.secret}
          onDismiss={() => setIssued(null)}
        />
      )}

      {list}

      {rotateTarget && (
        <RotateSecretDialog
          key={rotateTarget.id}
          endpoint={rotateTarget}
          onCancel={() => setRotateTarget(null)}
          onRotate={handleRotate}
        />
      )}

      <ConfirmDialog
        open={endpointToDelete !== null}
        onOpenChange={(open) => !open && setEndpointToDelete(null)}
        title="Delete Inbound Webhook Endpoint"
        description={`Are you sure you want to delete "${endpointToDelete?.label}"? Senders using this endpoint will stop being accepted.`}
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
