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
 * one back to `engine.ts`.
 *
 * The engine contract `main.ts`'s dispatch loop drives, implemented by both
 * `AgentLoop` (openai-api engine, agent-loop.ts) and `SdkEngine`
 * (claude-sdk engine, sdk-engine.ts). See
 * docs/design/embedded-agent-sdk-engine.md §3 "The seam" -- both engines
 * emit the same NDJSON event vocabulary upward; `main.ts` only needs this
 * narrow surface to drive either one.
 *
 * `AgentLoop` satisfies this interface structurally with no changes to
 * agent-loop.ts (a hard constraint of the SDK Engine Phase 1 work): it
 * already exposes `runTurn`/`cancel`/`handoff` with matching signatures, and
 * `dispose` is optional, so an `AgentLoop` instance is already assignable to
 * `Engine`.
 */
export interface Engine {
  /** Start (or continue) one user turn. Resolves once the turn concludes,
   * successfully or with a turn-level error -- never rejects for an
   * ordinary turn failure. */
  runTurn(id: string, text: string): Promise<void>;
  /** Abort the in-flight turn, if any. No-op when no turn is active. */
  cancel(): void;
  /** Context Handoff (Phase A for the native engine; a graceful
   * not-yet-supported stub for the SDK engine in Phase 1). */
  handoff(): Promise<void>;
  /**
   * Release any underlying resources held outside process memory (e.g. the
   * SDK engine's `Query`/child `claude` process). Optional because the
   * native engine has nothing to release beyond normal GC.
   */
  dispose?(): void;
}
