import { useEffect } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { fetchAgent } from '../../../lib/api';
import { EditAgentForm } from '../../../components/agents';
import { Spinner } from '../../../components/ui/Spinner';

export const Route = createFileRoute('/agents/$agentId/edit')({
  component: AgentEditPage,
});

function AgentEditPage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => fetchAgent(agentId),
  });

  // Redirect if agent is built-in (can't edit)
  useEffect(() => {
    if (data?.agent.isBuiltIn) {
      navigate({ to: '/agents/$agentId', params: { agentId } });
    }
  }, [data?.agent.isBuiltIn, agentId, navigate]);

  // Redirect if agent was deleted (query error)
  useEffect(() => {
    if (error && !isLoading) {
      navigate({ to: '/agents' });
    }
  }, [error, isLoading, navigate]);

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading agent...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
          <Link to="/" className="hover:text-white">Agent Console</Link>
          <span>/</span>
          <Link to="/agents" className="hover:text-white">Agents</Link>
          <span>/</span>
          <span className="text-white">Not Found</span>
        </div>
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Agent not found</p>
          <Link to="/agents" className="btn btn-primary">
            Back to Agents
          </Link>
        </div>
      </div>
    );
  }

  const agent = data.agent;

  // Don't render edit form for built-in agents (will redirect)
  if (agent.isBuiltIn) {
    return null;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/agents" className="hover:text-white">Agents</Link>
        <span>/</span>
        <Link to="/agents/$agentId" params={{ agentId }} className="hover:text-white">
          {agent.name}
        </Link>
        <span>/</span>
        <span className="text-white">Edit</span>
      </div>

      {/* Header */}
      <h1 className="text-2xl font-semibold mb-6">Edit Agent</h1>

      {/* Edit Form */}
      <EditAgentForm
        agentId={agentId}
        initialData={{
          name: agent.name,
          description: agent.description || '',
          commandTemplate: agent.commandTemplate,
          continueTemplate: agent.continueTemplate || '',
          headlessTemplate: agent.headlessTemplate || '',
          askingPatternsInput: agent.activityPatterns?.askingPatterns?.join('\n') || '',
        }}
        onSuccess={() => {
          navigate({ to: '/agents/$agentId', params: { agentId } });
        }}
        onCancel={() => {
          navigate({ to: '/agents/$agentId', params: { agentId } });
        }}
      />
    </div>
  );
}
