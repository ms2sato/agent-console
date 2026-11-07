import { useState } from 'react';
import { createFileRoute, Link, useNavigate, type ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { fetchRepository } from '../../../../../lib/api';
import { repositoryKeys } from '../../../../../lib/query-keys';
import { PageBreadcrumb } from '../../../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../../../components/PageErrorFallback';
import { ErrorDialog, useErrorDialog } from '../../../../../components/ui/error-dialog';
import { EndpointForm, type EndpointFormPayload } from '../../../../../components/settings/EndpointForm';
import { ReceiveUrl } from '../../../../../components/settings/ReceiveUrl';
import { SecretRevealPanel } from '../../../../../components/settings/SecretRevealPanel';
import {
  useInboundWebhookEndpointMutations,
  type IssuedSecret,
} from '../../../../../components/settings/hooks/useInboundWebhookEndpoints';

export const Route = createFileRoute('/settings/repositories/$repositoryId/inbound-webhooks/new')({
  component: NewInboundWebhookPage,
  pendingComponent: NewInboundWebhookPending,
  errorComponent: NewInboundWebhookError,
});

export function NewInboundWebhookPending() {
  return <PagePendingFallback message="Loading repository..." />;
}

export function NewInboundWebhookError({ error, reset }: ErrorComponentProps) {
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

function NewInboundWebhookPage() {
  const { repositoryId } = Route.useParams();
  return <NewInboundWebhookView repositoryId={repositoryId} />;
}

/** Presentational view of the create page, exported for tests that mount it without the route tree. */
export function NewInboundWebhookView({ repositoryId }: { repositoryId: string }) {
  const navigate = useNavigate();
  // A generated secret stays in this component's state and never crosses a navigation.
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data } = useSuspenseQuery({
    queryKey: repositoryKeys.detail(repositoryId),
    queryFn: () => fetchRepository(repositoryId),
  });
  const repository = data.repository;

  const { create, createEndpoint } = useInboundWebhookEndpointMutations(repositoryId, setIssued);

  const handleSubmit = async (payload: EndpointFormPayload) => {
    try {
      const outcome = await createEndpoint(payload);
      if (outcome.secretSource === 'entered') {
        await navigate({ to: '/settings/repositories/$repositoryId/inbound-webhooks', params: { repositoryId } });
      }
    } catch (err) {
      showError('Cannot Create Endpoint', err instanceof Error ? err.message : 'Failed to create endpoint');
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Repositories', to: '/settings/repositories' },
        { label: repository.name, to: '/settings/repositories/$repositoryId', params: { repositoryId } },
        { label: 'Inbound Webhooks', to: '/settings/repositories/$repositoryId/inbound-webhooks', params: { repositoryId } },
        { label: 'New' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">New Inbound Webhook Endpoint</h1>

      {issued ? (
        <SecretRevealPanel
          endpointLabel={issued.label}
          secret={issued.secret}
          action={
            <Link
              to="/settings/repositories/$repositoryId/inbound-webhooks"
              params={{ repositoryId }}
              className="btn btn-primary text-sm no-underline"
            >
              Done
            </Link>
          }
        >
          <ReceiveUrl endpointId={issued.endpointId} />
        </SecretRevealPanel>
      ) : (
        <>
          <EndpointForm mode="create" isPending={create.isPending} onSubmit={handleSubmit} />
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
      )}
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
