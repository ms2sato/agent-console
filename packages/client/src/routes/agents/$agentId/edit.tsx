import { useEffect } from 'react';
import { createFileRoute, useNavigate, type ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { fetchAgent } from '../../../lib/api';
import { agentKeys } from '../../../lib/query-keys';
import { PageBreadcrumb } from '../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../components/PageErrorFallback';
import { EditAgentForm } from '../../../components/agents';

export const Route = createFileRoute('/agents/$agentId/edit')({
  component: AgentEditPage,
  pendingComponent: AgentEditPending,
  errorComponent: AgentEditError,
});

export function AgentEditPending() {
  return <PagePendingFallback message="Loading agent..." />;
}

export function AgentEditError({ error, reset }: ErrorComponentProps) {
  return (
    <PageErrorFallback
      error={error}
      reset={reset}
      breadcrumbItems={[
        { label: 'Agent Console', to: '/' },
        { label: 'Agents', to: '/agents' },
        { label: 'Error' },
      ]}
      errorMessage="Failed to load agent"
      backTo="/agents"
      backLabel="Back to Agents"
    />
  );
}

function AgentEditPage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();

  const { data } = useSuspenseQuery({
    queryKey: agentKeys.detail(agentId),
    queryFn: () => fetchAgent(agentId),
  });
  const agent = data.agent;

  // Redirect if agent is built-in (can't edit)
  useEffect(() => {
    if (agent.isBuiltIn) {
      navigate({ to: '/agents/$agentId', params: { agentId } });
    }
  }, [agent.isBuiltIn, agentId, navigate]);

  // Don't render edit form for built-in agents (will redirect)
  if (agent.isBuiltIn) {
    return null;
  }

  const navigateToDetail = () => {
    navigate({ to: '/agents/$agentId', params: { agentId } });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Agents', to: '/agents' },
        { label: agent.name, to: '/agents/$agentId', params: { agentId } },
        { label: 'Edit' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">Edit Agent</h1>

      <EditAgentForm
        agentId={agentId}
        initialData={{
          name: agent.name,
          description: agent.description || '',
          commandTemplate: agent.commandTemplate,
          continueTemplate: agent.continueTemplate || '',
          headlessTemplate: agent.headlessTemplate || '',
          askingPatternsInput: agent.activityPatterns?.askingPatterns?.join('\n') || '',
          baseAgentId: agent.baseAgentId ?? '',
        }}
        onSuccess={navigateToDetail}
        onCancel={navigateToDetail}
      />
    </div>
  );
}
