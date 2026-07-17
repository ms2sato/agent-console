import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDefinition, AgentDirectoryEntry, AgentKind } from '@agent-console/shared';
import { fetchAgents } from '../lib/api';
import { agentKeys } from '../lib/query-keys';
import { useEmbeddedAgents } from '../hooks/useEmbeddedAgents';
import { useAgentDirectory } from '../hooks/useAgentDirectory';
import { AGENT_KIND_PRESENTATION, AgentKindNotice, type NoticeContext } from './agents';

function useSortedAgents(priorityAgentId?: string) {
  const { data, isLoading } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
  });

  const sortedAgents = useMemo(() => {
    const agents = data?.agents ?? [];
    if (!priorityAgentId) return agents;
    return [...agents].sort((a, b) => {
      if (a.id === priorityAgentId) return -1;
      if (b.id === priorityAgentId) return 1;
      return 0;
    });
  }, [data?.agents, priorityAgentId]);

  return { sortedAgents, isLoading };
}

/**
 * Hook that resolves the effective agent ID with fallback logic.
 * Returns the given value if it matches a known agent, otherwise falls back to the first
 * sorted agent. While loading, returns the original value unchanged.
 *
 * Shares the same TanStack Query cache as the agent pickers, so no extra network request is made.
 */
export function useResolvedAgentId(
  value: string | undefined,
  priorityAgentId?: string
): string | undefined {
  const { sortedAgents, isLoading } = useSortedAgents(priorityAgentId);

  if (isLoading) return value;
  const valueExists = value != null && sortedAgents.some((a) => a.id === value);
  return valueExists ? value : sortedAgents[0]?.id;
}

/**
 * Hook that resolves the effective embedded agent ID with fallback logic.
 * Unlike useResolvedAgentId, embedded agent selection is optional: an unknown/stale
 * value falls back to undefined (unset) rather than the first embedded agent.
 */
export function useResolvedEmbeddedAgentId(value: string | undefined): string | undefined {
  const { embeddedAgents, isLoading } = useEmbeddedAgents();

  if (isLoading) return value;
  const valueExists = value != null && embeddedAgents.some((a) => a.id === value);
  return valueExists ? value : undefined;
}

export function useAgents() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: fetchAgents,
  });

  return {
    agents: data?.agents ?? [],
    isLoading,
    error,
    refetch,
  };
}

export function getAgentName(agents: AgentDefinition[], agentId?: string): string {
  if (!agentId) return 'Unknown';
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? 'Unknown';
}

/**
 * Discriminated agent selection. Kept client-local (UI state, not wire
 * shape) -- see docs/design/agent-surface.md "Uniform listing principle".
 * Replaces the earlier non-discriminated `{ agentId?; embeddedAgentId? }`
 * shape, which could represent the invalid "both set" / "neither set"
 * states.
 */
export type AgentSelection =
  | { kind: 'terminal'; agentId: string }
  | { kind: 'embedded'; embeddedAgentId: string };

export interface UnifiedAgentSelectorDisabledKind {
  kind: AgentKind;
  context: NoticeContext;
}

export interface UnifiedAgentSelectorProps {
  agentId?: string;
  embeddedAgentId?: string;
  onChange: (selection: AgentSelection) => void;
  priorityAgentId?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Marks entries of the given kind(s) as disabled-with-notice rather than
   * omitting them. Entries of a disabled kind stay visible in the
   * `<select>` (uniform listing principle) but render with the `disabled`
   * attribute; `AgentKindNotice` renders once beneath the select for each
   * disabled kind that has at least one entry present.
   */
  disabledKinds?: UnifiedAgentSelectorDisabledKind[];
}

function isTerminalEntry(
  entry: AgentDirectoryEntry
): entry is Extract<AgentDirectoryEntry, { kind: 'terminal' }> {
  return entry.kind === 'terminal';
}

function isEmbeddedEntry(
  entry: AgentDirectoryEntry
): entry is Extract<AgentDirectoryEntry, { kind: 'embedded' }> {
  return entry.kind === 'embedded';
}

/**
 * Unified terminal + embedded agent picker (owner requirement: any surface
 * that presents agents as a list shows every AgentKind uniformly -- see
 * docs/design/agent-surface.md "Uniform listing principle").
 *
 * Values are prefixed by kind ('terminal:<id>' / 'embedded:<id>') internally
 * so a single <select> can represent both registries; onChange always
 * reports a discriminated AgentSelection.
 */
export function UnifiedAgentSelector({
  agentId,
  embeddedAgentId,
  onChange,
  className = '',
  disabled = false,
  priorityAgentId,
  disabledKinds = [],
}: UnifiedAgentSelectorProps) {
  const { entries, isLoading } = useAgentDirectory();

  const terminalEntries = useMemo(() => {
    const all = entries.filter(isTerminalEntry);
    if (!priorityAgentId) return all;
    return [...all].sort((a, b) => {
      if (a.agent.id === priorityAgentId) return -1;
      if (b.agent.id === priorityAgentId) return 1;
      return 0;
    });
  }, [entries, priorityAgentId]);

  const embeddedEntries = useMemo(() => entries.filter(isEmbeddedEntry), [entries]);

  const disabledKindSet = useMemo(
    () => new Set(disabledKinds.map((d) => d.kind)),
    [disabledKinds]
  );

  const terminalValueExists = agentId != null && terminalEntries.some((e) => e.agent.id === agentId);
  const embeddedValueExists =
    embeddedAgentId != null && embeddedEntries.some((e) => e.agent.id === embeddedAgentId);
  const selectedValue = embeddedValueExists
    ? `embedded:${embeddedAgentId}`
    : terminalValueExists
      ? `terminal:${agentId}`
      : terminalEntries[0]
        ? `terminal:${terminalEntries[0].agent.id}`
        : '';

  const handleChange = (raw: string) => {
    if (raw.startsWith('embedded:')) {
      onChange({ kind: 'embedded', embeddedAgentId: raw.slice('embedded:'.length) });
    } else if (raw.startsWith('terminal:')) {
      onChange({ kind: 'terminal', agentId: raw.slice('terminal:'.length) });
    }
  };

  if (isLoading) {
    return (
      <select className={`input ${className}`} disabled>
        <option>Loading...</option>
      </select>
    );
  }

  const activeNotices = disabledKinds.filter(({ kind }) =>
    kind === 'embedded' ? embeddedEntries.length > 0 : terminalEntries.length > 0
  );

  const optgroups = (
    <>
      <optgroup label={AGENT_KIND_PRESENTATION.terminal.optgroupLabel}>
        {terminalEntries.map(({ agent }) => (
          <option
            key={agent.id}
            value={`terminal:${agent.id}`}
            disabled={disabledKindSet.has('terminal')}
          >
            {agent.name}
            {agent.isBuiltIn ? ' (built-in)' : ''}
            {agent.baseAgentId ? ' (preset)' : ''}
          </option>
        ))}
      </optgroup>
      {embeddedEntries.length > 0 && (
        <optgroup label={AGENT_KIND_PRESENTATION.embedded.optgroupLabel}>
          {embeddedEntries.map(({ agent }) => (
            <option
              key={agent.id}
              value={`embedded:${agent.id}`}
              disabled={disabledKindSet.has('embedded')}
            >
              {agent.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  if (activeNotices.length === 0) {
    return (
      <select
        value={selectedValue}
        onChange={(e) => handleChange(e.target.value)}
        className={`input ${className}`}
        disabled={disabled}
      >
        {optgroups}
      </select>
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <select
        value={selectedValue}
        onChange={(e) => handleChange(e.target.value)}
        className="input w-full"
        disabled={disabled}
      >
        {optgroups}
      </select>
      {activeNotices.map(({ kind, context }) => (
        <AgentKindNotice key={`${context}-${kind}`} kind={kind} context={context} />
      ))}
    </div>
  );
}
