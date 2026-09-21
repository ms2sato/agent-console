/**
 * NOTE (naming-exemption guard): this file is named `engine-types.ts` (not
 * `engine.ts`) so it matches `check-utils.js`'s `COVERAGE_EXCLUSIONS`
 * `/-types\.tsx?$/` sibling-test exemption -- it currently holds only a type
 * declaration with no runtime logic, so the type system already enforces its
 * shape at consume sites and a sibling test would be tautological. If this
 * file ever grows runtime logic (a default implementation, a factory
 * function, an enum with behavior -- anything beyond type/interface
 * declarations), it loses the rationale for that exemption. Split the
 * runtime part into its own separate, tested file rather than renaming this
 * one back to `engine.ts`. (A sibling test file DOES still exist,
 * `__tests__/engine-types.test.ts` -- it hosts a type-level pin, not a
 * production-behavior test, and does not itself contradict this rationale.)
 *
 * The engine contract `main.ts`'s dispatch loop drives, implemented by both
 * `AgentLoop` (openai-api engine, agent-loop.ts) and `SdkEngine`
 * (claude-sdk engine, sdk-engine.ts). See
 * docs/design/embedded-agent-sdk-engine.md §3 "The seam" -- both engines
 * emit the same NDJSON event vocabulary upward; `main.ts` only needs this
 * narrow surface to drive either one.
 *
 * Phase 4 (#1683, decision 5): `Engine` keeps ONLY the surface both engines
 * share. The two methods only one engine ever had (`AgentLoop.compactNow`,
 * `SdkEngine.dispose`) moved off `Engine` entirely, onto kind-discriminated
 * interfaces that extend it -- `OpenAiApiEngine` / `ClaudeSdkEngine`, unioned
 * as `AnyEngine`. Before this split, both lived on `Engine` as OPTIONAL
 * members (`dispose?` / `compactNow?`), which meant every caller -- `main.ts`
 * included -- had to defensively `?.()` past a case that was actually
 * decided once, at construction, by which arm `initializeLoop` took: an
 * engine either always has `dispose` or never does, and the same is true of
 * `compactNow`. An optional method encodes "maybe", when the true shape is
 * "yes, on exactly this arm" -- exactly the "invalid states unrepresentable"
 * principle applied to a method's presence rather than a field's value. The
 * kind-discriminated union makes the presence a compile-time fact `main.ts`
 * narrows on (with an exhaustiveness check), rather than a runtime
 * `typeof loop.compactNow === 'function'` guess.
 */
import type { EmbeddedAgentAttachment, EmbeddedAgentDefinition } from '@agent-console/shared';

export interface Engine {
  /** Start (or continue) one user turn. Resolves once the turn concludes,
   * successfully or with a turn-level error -- never rejects for an
   * ordinary turn failure. `attachments` are resolved into
   * engine-specific content by each implementation. */
  runTurn(id: string, text: string, attachments?: EmbeddedAgentAttachment[]): Promise<void>;
  /** Abort the in-flight turn, if any. No-op when no turn is active. */
  cancel(): void;
  /**
   * Compaction: reflect a change to the worker's auto-compaction toggle
   * without waiting for the next activation.
   */
  setAutoCompaction(enabled: boolean): void;
  /**
   * agent-surface.md Phase 3: apply a mid-run model / reasoning-effort /
   * context-window change without waiting for the next activation.
   *
   * The payload is always the FULL effective triple, never a delta. The
   * server resolves override-versus-definition precedence and sends the
   * whole state on every change, so an implementation REPLACES its current
   * values rather than merging: an unchanged field arrives carrying its
   * current value, and `null` means "no override in effect" (a value to
   * apply, not a field to skip).
   *
   * `reasoningEffort` is `string | null` rather than the `claude-sdk` arm's
   * closed `EffortLevel` domain because one command shape serves both
   * engines; the closed domain is enforced by the server's shared parameter
   * validator before a value ever reaches an engine.
   *
   * Returns `void`, like {@link setAutoCompaction}: an engine reports
   * whether the change reached its LIVE session by emitting the
   * `model-params-applied` event, not through this return value. On `Engine`
   * itself (unlike `OpenAiApiEngine.compactNow` / `ClaudeSdkEngine.dispose`)
   * because both engines implement it.
   */
  setModelParams(params: {
    model: string;
    reasoningEffort: string | null;
    contextWindowTokens: number | null;
  }): void;
}

/**
 * The `openai-api` engine's own surface, implemented by `AgentLoop`
 * (agent-loop.ts). `kind` is derived from the wire vocabulary
 * (`EmbeddedAgentDefinition['engine']`) rather than a second string-literal
 * union -- there is exactly one writer of what the two engine values are.
 */
export interface OpenAiApiEngine extends Engine {
  readonly kind: Extract<EmbeddedAgentDefinition['engine'], 'openai-api'>;
  /**
   * Slash commands, `console`-handled arm (#1572): trigger a manual
   * compaction directly, outside any turn. Only `AgentLoop` (openai-api
   * engine) implements it -- `claude-sdk`'s own `/compact` is
   * `engine`-handled instead (forwarded as an ordinary user message the SDK
   * interprets itself; see `EMBEDDED_AGENT_SLASH_COMMANDS`), so `SdkEngine`
   * never needs this. The server never sends the `compact` wire command to a
   * `claude-sdk` worker either, but `main.ts`'s dispatch is exhaustive on
   * `kind` regardless (decision 4's "declines honestly": an explicit
   * unsupported result, never a silent no-op, for the case the type system
   * can no longer hide behind `?.()`).
   */
  compactNow(): Promise<void>;
}

/**
 * The `claude-sdk` engine's own surface, implemented by `SdkEngine`
 * (sdk-engine.ts). `kind` is derived from the wire vocabulary the same way
 * `OpenAiApiEngine.kind` is.
 */
export interface ClaudeSdkEngine extends Engine {
  readonly kind: Extract<EmbeddedAgentDefinition['engine'], 'claude-sdk'>;
  /**
   * Release any underlying resources held outside process memory (the SDK
   * engine's `Query`/child `claude` process). Only `SdkEngine` implements
   * this -- the openai-api engine has nothing to release beyond normal GC,
   * so there is no `dispose` on `OpenAiApiEngine` at all rather than a no-op
   * implementation of one.
   */
  dispose(): void;
  /**
   * epic #1636 Phase 5 PR-2 (docs/design/embedded-agent-sdk-engine.md §4.5
   * D-D "activation never waits"): reflect a newly-allowed set of `.mcp.json`
   * (Project scope) servers into the LIVE session without waiting for the
   * next activation. `claude-sdk`-only -- `openai-api` has no MCP
   * discovery/approval concept at all, so there is no `setMcpServers` on
   * `OpenAiApiEngine`; `main.ts`'s dispatch reports `unsupported-engine` on
   * that arm instead of calling a method that does not exist.
   *
   * `pairs` is the FULL currently-allowed (name, hash) set, never a delta --
   * same full-state contract as {@link Engine.setModelParams} and the
   * `set-mcp-servers` wire command's own doc comment. Architect ruling (B),
   * 2026-09-21: NO server config crosses this method's boundary either --
   * only names and hashes. The implementation (`SdkEngine.setMcpServers`,
   * sdk-engine.ts) resolves each pair against its own
   * `discoveredProjectMcpServers` map (populated at construction from
   * `discoverProjectMcpServers`, mcp-discovery.ts) and reports a pair that
   * does not resolve (unknown name, or a hash that no longer matches the
   * discovered entry) via `mcp-servers-applied.errors` rather than silently
   * dropping it.
   */
  setMcpServers(pairs: Array<{ name: string; hash: string }>): void;
}

/** Either engine `main.ts`'s dispatch loop may be driving, narrowed on
 * `kind` at every call site that needs an engine-specific method. */
export type AnyEngine = OpenAiApiEngine | ClaudeSdkEngine;
