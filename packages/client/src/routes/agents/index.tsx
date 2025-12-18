import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { registerAgent, unregisterAgent } from '../../lib/api';
import { useAgents } from '../../components/AgentSelector';
import { AgentForm, parseAskingPatterns, type AgentFormData } from '../../components/agents';
import { CapabilityIndicator } from '../../components/agents';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';
import { useAppWsState } from '../../hooks/useAppWs';

export const Route = createFileRoute('/agents/')({
  component: AgentsPage,
});

function AgentsPage() {
  const queryClient = useQueryClient();
  const agentsSynced = useAppWsState((s) => s.agentsSynced);
  const { agents, isLoading, error, refetch } = useAgents();
  const [showAddForm, setShowAddForm] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<AgentDefinition | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  // Show loading state until WebSocket sync completes
  const showLoading = isLoading || !agentsSynced;

  const unregisterMutation = useMutation({
    mutationFn: unregisterAgent,
    onSuccess: (_response, deletedAgentId) => {
      // Optimistic cache update (don't rely solely on WebSocket in case of disconnection)
      queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
        if (!old) return old;
        return { agents: old.agents.filter(a => a.id !== deletedAgentId) };
      });
      // Invalidate individual agent cache
      queryClient.invalidateQueries({ queryKey: ['agent', deletedAgentId] });
      setAgentToDelete(null);
    },
    onError: (error) => {
      setAgentToDelete(null);
      showError('Cannot Delete Agent', error.message);
    },
  });

  const handleDelete = (agent: AgentDefinition) => {
    if (agent.isBuiltIn) {
      showError('Cannot Delete', 'Built-in agents cannot be deleted');
      return;
    }
    setAgentToDelete(agent);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link to="/" className="hover:text-white">Agent Console</Link>
        <span>/</span>
        <span className="text-white">Agents</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <button
          onClick={() => setShowAddForm(true)}
          className="btn btn-primary text-sm"
        >
          + Add Agent
        </button>
      </div>

      {/* Add Agent Form */}
      {showAddForm && (
        <AddAgentForm
          onSuccess={() => {
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Loading State */}
      {showLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading agents...</span>
        </div>
      )}

      {/* Error State */}
      {!showLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load agents</p>
          <button onClick={() => refetch()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {/* Agent List */}
      {!showLoading && !error && (
        <div className="flex flex-col gap-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onDelete={() => handleDelete(agent)}
              isDeleting={unregisterMutation.isPending && agentToDelete?.id === agent.id}
            />
          ))}
        </div>
      )}

      {!showLoading && !error && agents.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-4">No agents registered</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="btn btn-primary"
          >
            Add your first agent
          </button>
        </div>
      )}

      {/* Delete Agent Confirmation */}
      <ConfirmDialog
        open={agentToDelete !== null}
        onOpenChange={(open) => !open && setAgentToDelete(null)}
        title="Delete Agent"
        description={`Are you sure you want to delete "${agentToDelete?.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (agentToDelete) {
            unregisterMutation.mutate(agentToDelete.id);
          }
        }}
        isLoading={unregisterMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

interface AgentCardProps {
  agent: AgentDefinition;
  onDelete: () => void;
  isDeleting: boolean;
}

function AgentCard({ agent, onDelete, isDeleting }: AgentCardProps) {
  const { capabilities } = agent;

  return (
    <div className="card">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {/* Name and badges */}
          <div className="text-lg font-medium flex items-center gap-2 mb-1">
            {agent.name}
            {agent.isBuiltIn && (
              <span className="text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                built-in
              </span>
            )}
          </div>

          {/* Command template */}
          <div className="text-sm text-gray-400 font-mono mb-2">
            {agent.commandTemplate}
          </div>

          {/* Description */}
          {agent.description && (
            <p className="text-sm text-gray-500 mb-2">{agent.description}</p>
          )}

          {/* Capability indicators */}
          <div className="flex gap-4 text-sm">
            <CapabilityIndicator enabled={capabilities.supportsContinue} label="Continue" />
            <CapabilityIndicator enabled={capabilities.supportsHeadlessMode} label="Headless" />
            <CapabilityIndicator enabled={capabilities.supportsActivityDetection} label="Activity Detection" />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 shrink-0">
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            className="btn text-sm bg-slate-700 hover:bg-slate-600 no-underline"
          >
            View
          </Link>
          {!agent.isBuiltIn && (
            <>
              <Link
                to="/agents/$agentId/edit"
                params={{ agentId: agent.id }}
                className="btn btn-primary text-sm no-underline"
              >
                Edit
              </Link>
              <button
                onClick={onDelete}
                disabled={isDeleting}
                className="btn btn-danger text-sm"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface AddAgentFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

function AddAgentForm({ onSuccess, onCancel }: AddAgentFormProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const registerMutation = useMutation({
    mutationFn: registerAgent,
    onSuccess: (response) => {
      // Optimistic cache update (don't rely solely on WebSocket in case of disconnection)
      const newAgent = response.agent;
      queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(['agents'], (old) => {
        if (!old) return { agents: [newAgent] };
        return { agents: [...old.agents, newAgent] };
      });
      onSuccess();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to register agent');
    },
  });

  const handleSubmit = (data: AgentFormData) => {
    setError(null);
    const askingPatterns = parseAskingPatterns(data.askingPatternsInput);
    registerMutation.mutate({
      name: data.name,
      commandTemplate: data.commandTemplate,
      continueTemplate: data.continueTemplate || undefined,
      headlessTemplate: data.headlessTemplate || undefined,
      description: data.description || undefined,
      activityPatterns: askingPatterns ? { askingPatterns } : undefined,
    });
  };

  return (
    <AgentForm
      mode="create"
      onSubmit={handleSubmit}
      onCancel={onCancel}
      isPending={registerMutation.isPending}
      error={error}
    />
  );
}
