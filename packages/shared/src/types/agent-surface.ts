/**
 * Cross-surface agent parity types (agent-surface migration PR-A).
 *
 * AgentDefinition (terminal agents) and EmbeddedAgentDefinition (embedded
 * agents) are deliberately separate registries with disjoint config shapes
 * and non-overlapping id namespaces (owner requirement, standing since the
 * embedded-agent v1 design). This file does NOT merge them -- it unifies
 * what each registry's consumers can query (AgentSurface / AgentDirectory),
 * not what each registry stores.
 *
 * See docs/design/agent-surface.md for the normative spec.
 */
import type { AgentDefinition } from './agent.js';
import type { EmbeddedAgentDefinition } from './embedded-agent.js';

/**
 * SINGLE WRITER of agent-kind literals. Every consumer derives from this
 * constant or the AgentKind type -- never a hardcoded 'terminal' | 'embedded'.
 */
export const AGENT_KINDS = ['terminal', 'embedded'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Full-fidelity, kind-tagged entry. Deliberately NOT a lossy summary
 * projection -- consumers narrow by `kind` (exhaustive switch / if-else).
 */
export type AgentDirectoryEntry =
  | { kind: 'terminal'; agent: AgentDefinition }
  | { kind: 'embedded'; agent: EmbeddedAgentDefinition };

/**
 * Per-registry query surface. K-generic so a terminal surface cannot
 * type-return an embedded entry.
 */
export interface AgentSurface<K extends AgentKind = AgentKind> {
  readonly kind: K;
  list(): Extract<AgentDirectoryEntry, { kind: K }>[];
  get(id: string): Extract<AgentDirectoryEntry, { kind: K }> | undefined;
  findByName(name: string): Extract<AgentDirectoryEntry, { kind: K }>[];
}

/** Result of cross-registry resolution (mirrors the #1165 facade contract). */
export type AgentResolution =
  | { ok: true; entry: AgentDirectoryEntry }
  | { ok: false; reason: 'not-found'; message: string }
  | { ok: false; reason: 'ambiguous'; message: string; candidates: AgentDirectoryEntry[] };
