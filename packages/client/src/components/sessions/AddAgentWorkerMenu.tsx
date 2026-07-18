import { useState, useRef, useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useAgentDirectory } from '../../hooks/useAgentDirectory';
import { AGENT_KIND_PRESENTATION } from '../agents';
import type { AddAgentWorkerParams } from './hooks/useTabManagement';

interface AddAgentWorkerMenuProps {
  onSelect: (params: AddAgentWorkerParams) => Promise<void>;
  onSelectShell: () => Promise<void>;
}

/**
 * Unified worker-creation entry point (owner requirement; spec §UI in
 * docs/design/embedded-agent-worker.md): lists a plain "Shell"
 * (terminal worker) item, terminal `AgentDefinition`s, and
 * `EmbeddedAgentDefinition`s in ONE list, each item carrying a kind badge.
 * The user never picks a "worker type" as a separate prior step -- the kind
 * is a property of the item they click. Shell is always first, since it
 * doesn't depend on the agents/embedded-agents queries and is the most
 * common action.
 *
 * Both terminal agent items and embedded-agent items are fully actionable:
 * `POST /api/sessions/:sessionId/workers` (`CreateWorkerRequestSchema`)
 * accepts `type: 'agent'` creation params in addition to `terminal` /
 * `embedded-agent`.
 *
 * The empty-embedded-registry footer links to `/agents`, which now hosts the
 * `EmbeddedAgentDefinition` management UI (Phase 3.5).
 */
export function AddAgentWorkerMenu({ onSelect, onSelectShell }: AddAgentWorkerMenuProps) {
  const [open, setOpen] = useState(false);
  const { entries, isLoading } = useAgentDirectory();
  const agents = useMemo(
    () => entries.filter((entry) => entry.kind === 'terminal').map((entry) => entry.agent),
    [entries]
  );
  const embeddedAgents = useMemo(
    () => entries.filter((entry) => entry.kind === 'embedded').map((entry) => entry.agent),
    [entries]
  );
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

  const handleSelectAgent = async (agentId: string) => {
    setOpen(false);
    await onSelect({ type: 'agent', agentId });
  };

  const handleSelectShell = async () => {
    setOpen(false);
    await onSelectShell();
  };

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
        +
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-72 max-h-96 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-lg"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => void handleSelectShell()}
            className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-gray-200 hover:bg-slate-700"
          >
            <span className="truncate">Shell</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300 shrink-0 ml-2">
              Shell
            </span>
          </button>
          {isLoading && <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>}
          {isEmpty && <div className="px-3 py-2 text-sm text-gray-400">No agents configured.</div>}
          {agents.map((agent) => (
            <button
              key={`agent-${agent.id}`}
              role="menuitem"
              type="button"
              onClick={() => void handleSelectAgent(agent.id)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-gray-200 hover:bg-slate-700"
            >
              <span className="truncate">{agent.name}</span>
              <span className={`${AGENT_KIND_PRESENTATION.terminal.badgeClassName} shrink-0 ml-2`}>
                {AGENT_KIND_PRESENTATION.terminal.badgeLabel}
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
              <span className={`${AGENT_KIND_PRESENTATION.embedded.badgeClassName} shrink-0 ml-2`}>
                {AGENT_KIND_PRESENTATION.embedded.badgeLabel}
              </span>
            </button>
          ))}
          {!isLoading && embeddedAgents.length === 0 && (
            <div className="border-t border-slate-700 px-3 py-2 text-xs text-gray-500">
              No embedded agents are registered yet.{' '}
              <Link
                to="/agents"
                onClick={() => setOpen(false)}
                className="text-blue-400 hover:text-blue-300 underline"
              >
                Create one
              </Link>
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}
