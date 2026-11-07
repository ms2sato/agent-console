import { createFileRoute, Link, useNavigate, type ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { fetchRepository } from '../../../../../../lib/api';
import { repositoryKeys } from '../../../../../../lib/query-keys';
import { PageBreadcrumb } from '../../../../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../../../../components/PageErrorFallback';
import { ErrorDialog, useErrorDialog } from '../../../../../../components/ui/error-dialog';
import { Spinner } from '../../../../../../components/ui/Spinner';
import { EndpointForm, type EndpointFormPayload } from '../../../../../../components/settings/EndpointForm';
import {
  useInboundWebhookEndpointQuery,
  useUpdateInboundWebhookEndpoint,
} from '../../../../../../components/settings/hooks/useInboundWebhookEndpoints';

export const Route = createFileRoute('/settings/repositories/$repositoryId/inbound-webhooks/$endpointId/edit')({
  component: EditInboundWebhookPage,
  pendingComponent: EditInboundWebhookPending,
  errorComponent: EditInboundWebhookError,
});

export function EditInboundWebhookPending() {
  return <PagePendingFallback message="Loading repository..." />;
}

export function EditInboundWebhookError({ error, reset }: ErrorComponentProps) {
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

function EditInboundWebhookPage() {
  const { repositoryId, endpointId } = Route.useParams();
  return <EditInboundWebhookView repositoryId={repositoryId} endpointId={endpointId} />;
}

/** Presentational view of the edit page, exported for tests that mount it without the route tree. */
export function EditInboundWebhookView({ repositoryId, endpointId }: { repositoryId: string; endpointId: string }) {
  const navigate = useNavigate();
  const { errorDialogProps, showError } = useErrorDialog();

  const { data } = useSuspenseQuery({
    queryKey: repositoryKeys.detail(repositoryId),
    queryFn: () => fetchRepository(repositoryId),
  });
  const repository = data.repository;

  const endpointQuery = useInboundWebhookEndpointQuery(repositoryId, endpointId);
  const update = useUpdateInboundWebhookEndpoint(repositoryId);

  const handleSubmit = async ({ label, instructionText }: EndpointFormPayload) => {
    try {
      await update.mutateAsync({ id: endpointId, request: { label, instructionText } });
      await navigate({ to: '/settings/repositories/$repositoryId/inbound-webhooks', params: { repositoryId } });
    } catch (err) {
      showError('Cannot Update Endpoint', err instanceof Error ? err.message : 'Failed to update endpoint');
    }
  };

  let body: React.ReactNode;
  if (endpointQuery.isLoading) {
    body = (
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading endpoint...</span>
      </div>
    );
  } else if (endpointQuery.error || !endpointQuery.data) {
    body = (
      <div className="card text-center py-10">
        <p className="text-red-400 mb-4">Failed to load inbound webhook endpoint</p>
        <button onClick={() => endpointQuery.refetch()} className="btn btn-primary">
          Retry
        </button>
      </div>
    );
  } else {
    const endpoint = endpointQuery.data.endpoint;
    body = (
      <>
        <EndpointForm
          key={endpoint.id}
          mode="edit"
          initial={{ label: endpoint.label, instructionText: endpoint.instructionText }}
          isPending={update.isPending}
          onSubmit={handleSubmit}
        />
        <div className="mt-3">
          <Link
            to="/settings/repositories/$repositoryId/inbound-webhooks"
            params={{ repositoryId }}
            className="text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </Link>
        </div>
      </>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: repository.name, to: '/settings/repositories/$repositoryId', params: { repositoryId } },
        { label: 'Inbound Webhooks', to: '/settings/repositories/$repositoryId/inbound-webhooks', params: { repositoryId } },
        { label: 'Edit' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">Edit Inbound Webhook Endpoint</h1>
      {body}
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
