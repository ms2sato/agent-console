import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentDefinition } from '@agent-console/shared';
import { registerAgent, unregisterAgent } from '../lib/api';
import { useAgents } from './AgentSelector';
import { ConfirmDialog } from './ui/confirm-dialog';

export function AgentManagement() {
  const queryClient = useQueryClient();
  const { agents, isLoading } = useAgents();
  const [showAddForm, setShowAddForm] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<AgentDefinition | null>(null);

  const unregisterMutation = useMutation({
    mutationFn: unregisterAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setAgentToDelete(null);
    },
  });

  const handleDelete = (agent: AgentDefinition) => {
    if (agent.isBuiltIn) {
      alert('Built-in agents cannot be deleted');
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
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [description, setDescription] = useState('');

  const registerMutation = useMutation({
    mutationFn: registerAgent,
    onSuccess: () => {
      onSuccess();
    },
  });

  const handleSubmit = async () => {
    if (!name.trim() || !command.trim()) {
      alert('Name and command are required');
      return;
    }

    try {
      await registerMutation.mutateAsync({
        name: name.trim(),
        command: command.trim(),
        description: description.trim() || undefined,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to register agent');
    }
  };

  return (
    <div className="bg-slate-800 p-4 rounded mb-4">
      <h3 className="text-sm font-medium mb-3">Add New Agent</h3>
      <div className="flex flex-col gap-3">
        <input
          type="text"
          placeholder="Agent name (e.g., My Custom Agent)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
        />
        <input
          type="text"
          placeholder="Command (e.g., my-agent, /usr/local/bin/agent)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="input"
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="input"
        />
        <div className="flex gap-2">
          <button
            onClick={handleSubmit}
            disabled={registerMutation.isPending}
            className="btn btn-primary text-sm"
          >
            {registerMutation.isPending ? 'Adding...' : 'Add Agent'}
          </button>
          <button onClick={onCancel} className="btn btn-danger text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
