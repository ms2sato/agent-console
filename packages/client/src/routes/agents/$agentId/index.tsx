import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchAgent, unregisterAgent } from '../../../lib/api';
import { CapabilityIndicator } from '../../../components/agents';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../../components/ui/error-dialog';
import { Spinner } from '../../../components/ui/Spinner';

export const Route = createFileRoute('/agents/$agentId/')({
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { errorDialogProps, showError } = useErrorDialog();

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => fetchAgent(agentId),
  });

  const deleteMutation = useMutation({
    mutationFn: unregisterAgent,
    onSuccess: () => {
      // Cache update is handled by WebSocket 'agent-deleted' event
      navigate({ to: '/agents' });
    },
    onError: (error) => {
      setShowDeleteConfirm(false);
      showError('Cannot Delete Agent', error.message);
    },
  });

  const handleDelete = () => {
    if (data?.agent.isBuiltIn) {
      showError('Cannot Delete', 'Built-in agents cannot be deleted');
      return;
    }
    setShowDeleteConfirm(true);
  };

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

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <Link to="/agents" className="hover:text-white">Agents</Link>
        <span>/</span>
        <span className="text-white">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{agent.name}</h1>
          {agent.isBuiltIn && (
            <span className="text-sm px-2 py-1 bg-blue-500/20 text-blue-400 rounded">
              built-in
            </span>
          )}
        </div>
        {!agent.isBuiltIn && (
          <div className="flex gap-2">
            <Link
              to="/agents/$agentId/edit"
              params={{ agentId }}
              className="btn btn-primary text-sm no-underline"
            >
              Edit
            </Link>
            <button onClick={handleDelete} className="btn btn-danger text-sm">
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Agent Details */}
      <div className="card">
        {/* Basic Info */}
        {agent.description && (
          <div className="mb-6">
            <p className="text-gray-300">{agent.description}</p>
          </div>
        )}

        {/* Templates Section */}
        <SectionHeader title="Templates" />
        <div className="space-y-4 mb-6">
          <DetailRow label="Command" value={agent.commandTemplate} mono />
          <DetailRow
            label="Continue"
            value={agent.continueTemplate || '(not set)'}
            mono
            muted={!agent.continueTemplate}
          />
          <DetailRow
            label="Headless"
            value={agent.headlessTemplate || '(not set)'}
            mono
            muted={!agent.headlessTemplate}
          />
        </div>

        {/* Activity Detection Section */}
        <SectionHeader title="Activity Detection" />
        <div className="space-y-4 mb-6">
          <DetailRow
            label="Asking Patterns"
            value={
              agent.activityPatterns?.askingPatterns?.length
                ? agent.activityPatterns.askingPatterns.join(', ')
                : '(none)'
            }
            mono={!!agent.activityPatterns?.askingPatterns?.length}
            muted={!agent.activityPatterns?.askingPatterns?.length}
          />
        </div>

        {/* Capabilities Section */}
        <SectionHeader title="Capabilities" />
        <div className="flex gap-6 mb-6">
          <CapabilityIndicator
            enabled={agent.capabilities.supportsContinue}
            label="Continue"
          />
          <CapabilityIndicator
            enabled={agent.capabilities.supportsHeadlessMode}
            label="Headless"
          />
          <CapabilityIndicator
            enabled={agent.capabilities.supportsActivityDetection}
            label="Activity Detection"
          />
        </div>

        {/* Metadata Section */}
        <SectionHeader title="Metadata" />
        <div className="space-y-2 text-sm text-gray-500">
          <div>
            <span className="text-gray-400">ID:</span>{' '}
            <span className="font-mono">{agent.id}</span>
          </div>
          {agent.registeredAt && (
            <div>
              <span className="text-gray-400">Registered:</span>{' '}
              {new Date(agent.registeredAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Agent"
        description={`Are you sure you want to delete "${agent.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          deleteMutation.mutate(agentId);
        }}
        isLoading={deleteMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3 pb-1 border-b border-slate-700">
      {title}
    </h3>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}

function DetailRow({ label, value, mono, muted }: DetailRowProps) {
  return (
    <div className="flex">
      <span className="w-32 text-gray-400 shrink-0">{label}:</span>
      <span
        className={`${mono ? 'font-mono text-sm' : ''} ${
          muted ? 'text-gray-600' : 'text-gray-200'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

