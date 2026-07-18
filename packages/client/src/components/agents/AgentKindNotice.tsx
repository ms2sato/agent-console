import type { AgentKind } from '@agent-console/shared';

/** Contexts in which an `AgentKind` may need an explanatory notice.
 *  Extend as new visible-but-restricted contexts arise. */
export type NoticeContext = 'restart';

/**
 * Per-(context, kind) notice text. Only kinds that actually need a notice
 * in a given context have an entry -- terminal has none today.
 *
 * Typed (not `satisfies`) as `Record<NoticeContext, Partial<Record<AgentKind, string>>>`
 * so every `AgentKind` is a valid index at every `NoticeContext` (returning
 * `undefined` when unregistered) while still gating `NoticeContext`
 * exhaustiveness at compile time -- every context must have an entry here,
 * even if it's `{}`.
 */
export const AGENT_KIND_CONTEXT_NOTICES: Record<NoticeContext, Partial<Record<AgentKind, string>>> = {
  restart: {
    embedded:
      'Restarting into an embedded agent requires cross-type restart support — tracked in #1171; conversation transcript restore (#1123) is its prerequisite.',
  },
};

export interface AgentKindNoticeProps {
  kind: AgentKind;
  context: NoticeContext;
}

/**
 * Explains why an `AgentKind` is visible-but-restricted in a given context
 * (e.g. an embedded agent shown but disabled in the restart-agent picker).
 *
 * Renders nothing when no notice is registered for the (context, kind)
 * pair. This component MUST NEVER filter a list -- it only explains state;
 * it must not gain a prop that could suppress an entry from rendering.
 */
export function AgentKindNotice({ kind, context }: AgentKindNoticeProps) {
  const text = AGENT_KIND_CONTEXT_NOTICES[context][kind];
  if (!text) return null;
  return <p className="text-xs text-yellow-400">{text}</p>;
}
