import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { valibotResolver } from '@hookform/resolvers/valibot';
import type { AgentDefinition, CreateAgentRequest } from '@agent-console/shared';
import { CreateAgentRequestSchema } from '@agent-console/shared';
import { registerAgent, unregisterAgent } from '../lib/api';
import { useAgents } from './AgentSelector';
import { ConfirmDialog } from './ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from './ui/error-dialog';
import { FormField, Input } from './ui/FormField';

export function AgentManagement() {
  const queryClient = useQueryClient();
  const { agents, isLoading } = useAgents();
  const [showAddForm, setShowAddForm] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<AgentDefinition | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const unregisterMutation = useMutation({
    mutationFn: unregisterAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setAgentToDelete(null);
    },
  });

  const handleDelete = (agent: AgentDefinition) => {
    if (agent.isBuiltIn) {
      showError('Cannot Delete', 'Built-in agents cannot be deleted');
      return;
    }
    setAgentToDelete(agent);
  };

  if (isLoading) {
    return <div className="text-gray-500">Loading agents...</div>;
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium">Agents</h2>
        <button
          onClick={() => setShowAddForm(true)}
          className="btn btn-primary text-sm"
        >
          + Add Agent
        </button>
      </div>

      {showAddForm && (
        <AddAgentForm
          onSuccess={() => {
            setShowAddForm(false);
            queryClient.invalidateQueries({ queryKey: ['agents'] });
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="flex flex-col gap-2">
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            onDelete={() => handleDelete(agent)}
            isDeleting={unregisterMutation.isPending}
          />
        ))}
      </div>

      {agents.length === 0 && (
        <p className="text-sm text-gray-500">No agents registered</p>
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

interface AgentRowProps {
  agent: AgentDefinition;
  onDelete: () => void;
  isDeleting: boolean;
}

function AgentRow({ agent, onDelete, isDeleting }: AgentRowProps) {
  return (
    <div className="flex items-center gap-3 p-3 bg-slate-800 rounded">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {agent.name}
          {agent.isBuiltIn && (
            <span className="text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
              built-in
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          <span className="font-mono">{agent.command}</span>
          {agent.description && (
            <span className="ml-2">- {agent.description}</span>
          )}
        </div>
      </div>
      <button
        onClick={onDelete}
        disabled={agent.isBuiltIn || isDeleting}
        className={`btn text-xs ${
          agent.isBuiltIn
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'btn-danger'
        }`}
        title={agent.isBuiltIn ? 'Built-in agents cannot be deleted' : 'Delete agent'}
      >
        Delete
      </button>
    </div>
  );
}

interface AddAgentFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

function AddAgentForm({ onSuccess, onCancel }: AddAgentFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CreateAgentRequest>({
    resolver: valibotResolver(CreateAgentRequestSchema),
    defaultValues: {
      name: '',
      command: '',
      description: '',
    },
    mode: 'onBlur',
  });

  const registerMutation = useMutation({
    mutationFn: registerAgent,
    onSuccess: () => {
      onSuccess();
    },
  });

  const onSubmit = async (data: CreateAgentRequest) => {
    try {
      await registerMutation.mutateAsync({
        name: data.name,
        command: data.command,
        description: data.description || undefined,
      });
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Failed to register agent',
      });
    }
  };

  return (
    <div className="bg-slate-800 p-4 rounded mb-4">
      <h3 className="text-sm font-medium mb-3">Add New Agent</h3>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <FormField label="Name" error={errors.name}>
          <Input
            {...register('name')}
            placeholder="Agent name (e.g., My Custom Agent)"
            error={errors.name}
          />
        </FormField>
        <FormField label="Command" error={errors.command}>
          <Input
            {...register('command')}
            placeholder="Command (e.g., my-agent, /usr/local/bin/agent)"
            error={errors.command}
          />
        </FormField>
        <FormField label="Description (optional)" error={errors.description}>
          <Input
            {...register('description')}
            placeholder="Description"
            error={errors.description}
          />
        </FormField>
        {errors.root && (
          <p className="text-sm text-red-400">{errors.root.message}</p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={registerMutation.isPending}
            className="btn btn-primary text-sm"
          >
            {registerMutation.isPending ? 'Adding...' : 'Add Agent'}
          </button>
          <button type="button" onClick={onCancel} className="btn btn-danger text-sm">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
