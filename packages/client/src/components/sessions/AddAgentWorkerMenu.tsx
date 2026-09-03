import { useState, useRef, useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useAgentDirectory } from '../../hooks/useAgentDirectory';
import { AGENT_KIND_PRESENTATION } from '../agents';
import { AgentParameterFields } from '../agents/AgentParameterFields';
import type { AgentSelection } from '../AgentSelector';
import type { AgentDirectoryEntry, AgentParameterCapabilitiesByKind } from '@agent-console/shared';
import { getAgentParameterCapabilitiesFor } from '@agent-console/shared';
import type { AddAgentWorkerParams } from './hooks/useTabManagement';

interface AddAgentWorkerMenuProps {
  onSelect: (params: AddAgentWorkerParams) => Promise<void>;
  onSelectShell: () => Promise<void>;
  /**
   * Injectable seam for the kind-dispatch capability accessor, defaulting to
   * the real `getAgentParameterCapabilitiesFor` (agent-surface.ts's SINGLE
   * kind-dispatch entry point). Used for BOTH the per-item Options-toggle
   * gate below AND passed straight through to `AgentParameterFields`'s own
   * `getCapabilitiesImpl` prop -- the same discipline that component
   * documents at its own top of file: this menu never branches on
   * `entry.kind` itself to decide capability, it hands the whole
   * `AgentDirectoryEntry` to this one seam. A test can inject a stub here to
   * prove the toggle gate and the rendered fields cannot disagree.
   */
  getCapabilitiesImpl?: (entry: AgentDirectoryEntry) => AgentParameterCapabilitiesByKind;
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
 *
 * Per-item Options toggle: each agent item whose resolved
 * capability (`getCapabilitiesImpl`) has any `true` value renders a
 * secondary "Options" toggle next to its name. Clicking the toggle expands
 * `AgentParameterFields` bound to that item's `AgentSelection` directly
 * under the row, plus an "Add" button that composes the final
 * `AddAgentWorkerParams` including any typed overrides. Clicking the item's
 * NAME (not the toggle) is unchanged: it still adds immediately with no
 * overrides, and never reads the options panel's state even if some item's
 * panel happens to be open. Exactly one item's panel can be open at a time;
 * switching or closing the menu clears the typed values.
 */
export function AddAgentWorkerMenu({
  onSelect,
  onSelectShell,
  getCapabilitiesImpl = getAgentParameterCapabilitiesFor,
}: AddAgentWorkerMenuProps) {
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

  // Per-item Options panel state. Exactly one item's panel can
  // be expanded at a time; `expandedKey` identifies it using the same
  // `key` values already used by the `.map()` calls below.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [optionsModel, setOptionsModel] = useState<string | undefined>(undefined);
  const [optionsReasoningEffort, setOptionsReasoningEffort] = useState<string | undefined>(
    undefined
  );
  const [optionsContextWindowTokens, setOptionsContextWindowTokens] = useState<
    number | undefined
  >(undefined);

  function resetOptionsState() {
    setExpandedKey(null);
    setOptionsModel(undefined);
    setOptionsReasoningEffort(undefined);
    setOptionsContextWindowTokens(undefined);
  }

  function handleToggleOptions(itemKey: string) {
    setExpandedKey((prev) => {
      // Both the collapse and the switch-to-a-different-item cases clear
      // the typed values -- a stale value from a previously expanded item
      // must never ride along into another item's panel (mirrors
      // QuickSessionForm.tsx's clear-on-switch).
      setOptionsModel(undefined);
      setOptionsReasoningEffort(undefined);
      setOptionsContextWindowTokens(undefined);
      return prev === itemKey ? null : itemKey;
    });
  }

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        resetOptionsState();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleSelectEmbeddedAgent = async (embeddedAgentId: string) => {
    setOpen(false);
    resetOptionsState();
    await onSelect({ type: 'embedded-agent', embeddedAgentId });
  };

  const handleSelectAgent = async (agentId: string) => {
    setOpen(false);
    resetOptionsState();
    await onSelect({ type: 'agent', agentId });
  };

  const handleSelectShell = async () => {
    setOpen(false);
    resetOptionsState();
    await onSelectShell();
  };

  // Value handling mirrors QuickSessionForm.tsx: trim; empty/whitespace
  // becomes absent (undefined). A cleared model also clears
  // contextWindowTokens -- AgentParameterFields already hides that input
  // once model is empty, but the stored value must also be dropped so a
  // stale number never rides along in the POST body (agent-surface.md
  // Ruling 4).
  const handleOptionsModelChange = (value: string) => {
    const trimmed = value.trim() || undefined;
    setOptionsModel(trimmed);
    if (!trimmed) setOptionsContextWindowTokens(undefined);
  };

  const handleOptionsReasoningEffortChange = (value: string) => {
    setOptionsReasoningEffort(value.trim() || undefined);
  };

  const handleAddWithOptions = async (selection: AgentSelection) => {
    setOpen(false);
    const params: AddAgentWorkerParams =
      selection.kind === 'terminal'
        ? {
            type: 'agent',
            agentId: selection.agentId,
            ...(optionsModel ? { model: optionsModel } : {}),
            ...(optionsReasoningEffort ? { reasoningEffort: optionsReasoningEffort } : {}),
          }
        : {
            type: 'embedded-agent',
            embeddedAgentId: selection.embeddedAgentId,
            ...(optionsModel ? { model: optionsModel } : {}),
            ...(optionsReasoningEffort ? { reasoningEffort: optionsReasoningEffort } : {}),
            ...(optionsContextWindowTokens !== undefined
              ? { contextWindowTokens: optionsContextWindowTokens }
              : {}),
          };
    resetOptionsState();
    await onSelect(params);
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
          {agents.map((agent) => {
            const entry: AgentDirectoryEntry = { kind: 'terminal', agent };
            const capabilities = getCapabilitiesImpl(entry);
            const hasOptions =
              capabilities.model || capabilities.reasoningEffort || capabilities.contextWindowTokens;
            const itemKey = `agent-${agent.id}`;
            const selection: AgentSelection = { kind: 'terminal', agentId: agent.id };
            const isExpanded = expandedKey === itemKey;
            return (
              <div key={itemKey}>
                <div className="flex items-center hover:bg-slate-700">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => void handleSelectAgent(agent.id)}
                    className="flex-1 min-w-0 flex items-center justify-between px-3 py-2 text-sm text-left text-gray-200"
                  >
                    <span className="truncate">{agent.name}</span>
                    <span className={`${AGENT_KIND_PRESENTATION.terminal.badgeClassName} shrink-0 ml-2`}>
                      {AGENT_KIND_PRESENTATION.terminal.badgeLabel}
                    </span>
                  </button>
                  {hasOptions && (
                    <button
                      type="button"
                      aria-label={`Options for ${agent.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleOptions(itemKey)}
                      className="px-2 py-2 text-gray-400 hover:text-white shrink-0"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="px-3 py-2 bg-slate-900/40 border-t border-b border-slate-700 flex flex-col gap-2">
                    <AgentParameterFields
                      selection={selection}
                      model={optionsModel}
                      reasoningEffort={optionsReasoningEffort}
                      contextWindowTokens={optionsContextWindowTokens}
                      onModelChange={handleOptionsModelChange}
                      onReasoningEffortChange={handleOptionsReasoningEffortChange}
                      onContextWindowTokensChange={setOptionsContextWindowTokens}
                      getCapabilitiesImpl={getCapabilitiesImpl}
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddWithOptions(selection)}
                      className="btn btn-primary text-xs self-start"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {embeddedAgents.map((embeddedAgent) => {
            const entry: AgentDirectoryEntry = { kind: 'embedded', agent: embeddedAgent };
            const capabilities = getCapabilitiesImpl(entry);
            const hasOptions =
              capabilities.model || capabilities.reasoningEffort || capabilities.contextWindowTokens;
            const itemKey = `embedded-agent-${embeddedAgent.id}`;
            const selection: AgentSelection = { kind: 'embedded', embeddedAgentId: embeddedAgent.id };
            const isExpanded = expandedKey === itemKey;
            return (
              <div key={itemKey}>
                <div className="flex items-center hover:bg-slate-700">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => void handleSelectEmbeddedAgent(embeddedAgent.id)}
                    className="flex-1 min-w-0 flex items-center justify-between px-3 py-2 text-sm text-left text-gray-200"
                  >
                    <span className="truncate">{embeddedAgent.name}</span>
                    <span className={`${AGENT_KIND_PRESENTATION.embedded.badgeClassName} shrink-0 ml-2`}>
                      {AGENT_KIND_PRESENTATION.embedded.badgeLabel}
                    </span>
                  </button>
                  {hasOptions && (
                    <button
                      type="button"
                      aria-label={`Options for ${embeddedAgent.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleOptions(itemKey)}
                      className="px-2 py-2 text-gray-400 hover:text-white shrink-0"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="px-3 py-2 bg-slate-900/40 border-t border-b border-slate-700 flex flex-col gap-2">
                    <AgentParameterFields
                      selection={selection}
                      model={optionsModel}
                      reasoningEffort={optionsReasoningEffort}
                      contextWindowTokens={optionsContextWindowTokens}
                      onModelChange={handleOptionsModelChange}
                      onReasoningEffortChange={handleOptionsReasoningEffortChange}
                      onContextWindowTokensChange={setOptionsContextWindowTokens}
                      getCapabilitiesImpl={getCapabilitiesImpl}
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddWithOptions(selection)}
                      className="btn btn-primary text-xs self-start"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {!isLoading && embeddedAgents.length === 0 && (
            <div className="border-t border-slate-700 px-3 py-2 text-xs text-gray-500">
              No embedded agents are registered yet.{' '}
              <Link
                to="/agents"
                onClick={() => {
                  setOpen(false);
                  resetOptionsState();
                }}
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
