import { useState, useRef, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useAgents } from '../AgentSelector';
import { useEmbeddedAgents } from './hooks/useEmbeddedAgents';
import type { AddAgentWorkerParams } from './hooks/useTabManagement';

interface AddAgentWorkerMenuProps {
  onSelect: (params: AddAgentWorkerParams) => Promise<void>;
}

/**
 * Unified agent-selection entry point (owner requirement, spec §UI in
 * docs/design/embedded-agent-worker.md): lists terminal `AgentDefinition`s
 * and `EmbeddedAgentDefinition`s in ONE list, each item carrying a kind
 * badge. The user never picks a "worker type" as a separate prior step --
 * the kind is a property of the item they click.
 *
 * Judgment call: `POST /api/sessions/:sessionId/workers`
 * (`CreateWorkerRequestSchema`) only accepts `terminal` / `embedded-agent`
 * creation params -- adding a terminal `agent`-backed worker to an already
 * running session has never been REST-supported (it is only ever created at
 * session-creation time). Widening that schema is a server change outside
 * this PR's scope (client-only). Terminal items are therefore shown for
 * completeness (so the unified list matches the design) but are disabled
 * with an explanatory tooltip rather than wired to a call that would always
 * 400. Embedded-agent items are fully actionable today.
 */
export function AddAgentWorkerMenu({ onSelect }: AddAgentWorkerMenuProps) {
  const [open, setOpen] = useState(false);
  const { agents, isLoading: agentsLoading } = useAgents();
  const { embeddedAgents, isLoading: embeddedLoading } = useEmbeddedAgents();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleSelectEmbeddedAgent = async (embeddedAgentId: string) => {
    setOpen(false);
    await onSelect({ type: 'embedded-agent', embeddedAgentId });
  };

  const isLoading = agentsLoading || embeddedLoading;
  const isEmpty = !isLoading && agents.length === 0 && embeddedAgents.length === 0;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="px-3 py-2 text-gray-400 hover:text-white hover:bg-slate-700"
        title="Add agent worker"
        aria-label="Add agent worker"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + Agent
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-72 max-h-96 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-lg"
        >
          {isLoading && <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>}
          {isEmpty && <div className="px-3 py-2 text-sm text-gray-400">No agents configured.</div>}
          {agents.map((agent) => (
            <button
              key={`agent-${agent.id}`}
              role="menuitem"
              type="button"
              disabled
              title="Adding a terminal agent to a running session isn't supported yet"
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-gray-500 cursor-not-allowed"
            >
              <span className="truncate">{agent.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 shrink-0 ml-2">
                Terminal
              </span>
            </button>
          ))}
          {embeddedAgents.map((embeddedAgent) => (
            <button
              key={`embedded-agent-${embeddedAgent.id}`}
              role="menuitem"
              type="button"
              onClick={() => void handleSelectEmbeddedAgent(embeddedAgent.id)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-gray-200 hover:bg-slate-700"
            >
              <span className="truncate">{embeddedAgent.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 shrink-0 ml-2">
                Embedded
              </span>
            </button>
          ))}
          <div className="border-t border-slate-700 px-3 py-2">
            <Link to="/agents" className="text-xs text-blue-400 hover:underline" onClick={() => setOpen(false)}>
              Manage agents / create an embedded agent...
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
