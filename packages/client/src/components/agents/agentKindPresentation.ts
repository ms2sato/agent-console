import type { AgentKind } from '@agent-console/shared';

export interface AgentKindPresentation {
  /** Short badge text shown next to a list item (e.g. AddAgentWorkerMenu). */
  badgeLabel: string;
  /** Label used for the `<optgroup>` in unified `<select>` pickers. */
  optgroupLabel: string;
  /** Tailwind classes for the badge (colors preserved verbatim from the
   *  pre-existing inline markup this table replaces). */
  badgeClassName: string;
}

/**
 * SINGLE WRITER of agent-kind presentation (badge/optgroup labels + colors).
 * Every surface that renders a kind badge or optgroup derives from this
 * table -- never a hardcoded label/className duplicated per component.
 *
 * `satisfies Record<AgentKind, AgentKindPresentation>` is the compile-time
 * exhaustiveness gate: adding a third `AgentKind` fails the build here
 * until this table is updated (mirrors the `AgentDirectory` constructor's
 * mapped-type gate described in docs/design/agent-surface.md).
 */
export const AGENT_KIND_PRESENTATION = {
  terminal: {
    badgeLabel: 'Terminal',
    optgroupLabel: 'Terminal',
    badgeClassName: 'text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300',
  },
  embedded: {
    badgeLabel: 'Embedded · Experimental',
    optgroupLabel: 'Embedded (Experimental)',
    badgeClassName: 'text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300',
  },
} satisfies Record<AgentKind, AgentKindPresentation>;
