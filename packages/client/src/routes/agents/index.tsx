import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentDefinition, EmbeddedAgentDefinition } from '@agent-console/shared';
import { unregisterAgent, deleteEmbeddedAgent } from '../../lib/api';
import { agentKeys, embeddedAgentKeys } from '../../lib/query-keys';
import { useAgents } from '../../components/AgentSelector';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { AddAgentForm, CapabilityIndicator } from '../../components/agents';
import {
  AddEmbeddedAgentForm,
  EditEmbeddedAgentForm,
  EmbeddedAgentDeleteDialog,
  canManageEmbeddedAgent,
  findReferencingWorkers,
  type EmbeddedAgentWorkerReference,
} from '../../components/embedded-agents';
import { useEmbeddedAgents } from '../../components/sessions/hooks/useEmbeddedAgents';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';
import { useAppWsState } from '../../hooks/useAppWs';
import { useSessionDataContext } from '../../contexts/root-contexts';
import { useAuth } from '../../lib/auth';

export const Route = createFileRoute('/agents/')({
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Agents' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">Agents</h1>

      <TerminalAgentsSection />
      <EmbeddedAgentsSection />
    </div>
  );
}

// ===========================================================================
// Terminal Agents
// ===========================================================================

function TerminalAgentsSection() {
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
      queryClient.setQueryData<{ agents: AgentDefinition[] } | undefined>(agentKeys.all(), (old) => {
        if (!old) return old;
        return { agents: old.agents.filter(a => a.id !== deletedAgentId) };
      });
      // Invalidate individual agent cache
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(deletedAgentId) });
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
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium flex items-center gap-2">
          Terminal Agents
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">
            Terminal
          </span>
        </h2>
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
    </section>
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

// ===========================================================================
// Embedded Agents
// ===========================================================================

function EmbeddedAgentsSection() {
  const queryClient = useQueryClient();
  const { embeddedAgents, isLoading, error, refetch } = useEmbeddedAgents();
  const { currentUser, isMultiUser } = useAuth();
  const { sessions } = useSessionDataContext();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentToDelete, setAgentToDelete] = useState<EmbeddedAgentDefinition | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const referencingWorkers: EmbeddedAgentWorkerReference[] = agentToDelete
    ? findReferencingWorkers(sessions, agentToDelete.id)
    : [];

  const deleteMutation = useMutation({
    mutationFn: deleteEmbeddedAgent,
    onSuccess: () => {
      // Don't rely solely on the WS `embedded-agent-deleted` broadcast in
      // case of disconnection (mirrors TerminalAgentsSection's
      // unregisterMutation.onSuccess). Plain invalidate-and-refetch is
      // sufficient here (matches AddEmbeddedAgentForm/EditEmbeddedAgentForm,
      // which also don't use an optimistic splice for this small registry).
      queryClient.invalidateQueries({ queryKey: embeddedAgentKeys.all() });
      setAgentToDelete(null);
    },
    onError: (err) => {
      setAgentToDelete(null);
      showError('Cannot Delete Embedded Agent', err instanceof Error ? err.message : 'Failed to delete embedded agent');
    },
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium flex items-center gap-2">
          Embedded Agents
          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300">
            Embedded
          </span>
        </h2>
        <button
          onClick={() => setShowAddForm(true)}
          className="btn btn-primary text-sm"
        >
          + Add Embedded Agent
        </button>
      </div>

      {showAddForm && (
        <AddEmbeddedAgentForm
          onSuccess={() => setShowAddForm(false)}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500">
          <Spinner size="sm" />
          <span>Loading embedded agents...</span>
        </div>
      )}

      {!isLoading && error && (
        <div className="card text-center py-10">
          <p className="text-red-400 mb-4">Failed to load embedded agents</p>
          <button onClick={() => refetch()} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="flex flex-col gap-3">
          {embeddedAgents.map((embeddedAgent) =>
            editingAgentId === embeddedAgent.id ? (
              <EditEmbeddedAgentForm
                key={embeddedAgent.id}
                embeddedAgentId={embeddedAgent.id}
                initialData={{
                  name: embeddedAgent.name,
                  description: embeddedAgent.description ?? '',
                  baseUrl: embeddedAgent.provider.baseUrl,
                  model: embeddedAgent.provider.model,
                  apiKeyRef: embeddedAgent.provider.apiKeyRef ?? '',
                  systemPrompt: embeddedAgent.systemPrompt ?? '',
                  maxToolIterationsInput: embeddedAgent.maxToolIterations?.toString() ?? '',
                }}
                onSuccess={() => setEditingAgentId(null)}
                onCancel={() => setEditingAgentId(null)}
              />
            ) : (
              <EmbeddedAgentCard
                key={embeddedAgent.id}
                embeddedAgent={embeddedAgent}
                canManage={canManageEmbeddedAgent(embeddedAgent.createdBy, currentUser?.id, isMultiUser)}
                onEdit={() => setEditingAgentId(embeddedAgent.id)}
                onDelete={() => setAgentToDelete(embeddedAgent)}
                isDeleting={deleteMutation.isPending && agentToDelete?.id === embeddedAgent.id}
              />
            )
          )}
        </div>
      )}

      {!isLoading && !error && embeddedAgents.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-4">No embedded agents registered</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="btn btn-primary"
          >
            Add your first embedded agent
          </button>
        </div>
      )}

      <EmbeddedAgentDeleteDialog
        embeddedAgent={agentToDelete}
        referencingWorkers={referencingWorkers}
        onOpenChange={(open) => !open && setAgentToDelete(null)}
        onConfirm={() => {
          if (agentToDelete) {
            deleteMutation.mutate(agentToDelete.id);
          }
        }}
        isLoading={deleteMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </section>
  );
}

interface EmbeddedAgentCardProps {
  embeddedAgent: EmbeddedAgentDefinition;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function EmbeddedAgentCard({ embeddedAgent, canManage, onEdit, onDelete, isDeleting }: EmbeddedAgentCardProps) {
  return (
    <div className="card">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-lg font-medium mb-1">{embeddedAgent.name}</div>

          <div className="text-sm text-gray-400 font-mono mb-2">
            {embeddedAgent.provider.baseUrl} &middot; {embeddedAgent.provider.model}
          </div>

          {embeddedAgent.description && (
            <p className="text-sm text-gray-500 mb-2">{embeddedAgent.description}</p>
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          {canManage && (
            <>
              <button onClick={onEdit} className="btn btn-primary text-sm">
                Edit
              </button>
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
