/**
 * StartupIntent - the resolved decision for how an agent worker's PTY
 * should start: continue an existing conversation, deliver a pending
 * initial prompt, or start fresh with neither.
 *
 * A single pure resolver replaces the scattered `continueConversation`
 * boolean plus the ad-hoc `shouldRedeliverInitialPrompt` conjunct that used
 * to live at each call site. Every consumer (template selection, the
 * restart redelivery gate) reads the resolved `StartupIntent` value; none
 * re-derive it from raw worker/session state.
 *
 * `resolveStartupIntent`'s `obligated` check is the single writer for this
 * rule ONLY on the PTY-backed agent-worker path. The embedded-agent path
 * has its own family-scoped single writer for the identical rule --
 * `hasUndeliveredInitialPrompt` in `embedded-agent-worker-service.ts` --
 * kept separate deliberately: that function takes typed internal
 * worker/session and serves delivery plus revival for the embedded path;
 * this resolver takes a plain input shape and additionally folds in a
 * caller preference the embedded path has no concept of. A third family
 * wanting this exact conjunct is the trigger to extract the bare
 * predicate, not before.
 */

/**
 * The resolved startup decision for an agent worker's PTY activation.
 * - `continue` - resume the existing conversation (`-c`-style template).
 * - `deliver-initial-prompt` - start fresh and (re)inject the session's
 *   pending initial prompt.
 * - `fresh` - start fresh with no prompt delivery.
 */
export type StartupIntent = 'continue' | 'deliver-initial-prompt' | 'fresh';

/**
 * The caller's preference, fed into `resolveStartupIntent` alongside the
 * worker/session obligation facts.
 * - `continue` - the caller explicitly chose to continue (e.g. the
 *   per-session restart dialog's "continue" option). Honored unconditionally.
 * - `fresh` - the caller explicitly chose NOT to continue (e.g. the
 *   per-session restart dialog's "fresh" option, or ordinary worker
 *   creation). Still redelivers a pending initial prompt if one is owed.
 * - `system` - the caller has no conversation preference of its own (e.g.
 *   Restart All); the resolver picks `continue` unless a prompt is owed.
 */
export type StartupIntentPreference = 'continue' | 'fresh' | 'system';

/**
 * Facts the resolver needs to determine whether the session's initial
 * prompt is still owed to this worker. All three come from already-persisted
 * worker/session state; the resolver does not read anything else.
 */
export interface StartupIntentInput {
  /** Whether this worker is eligible to receive the session's initialPrompt. */
  deliverInitialPromptOnActivation: boolean;
  /** The session's initial prompt text, if any. */
  initialPrompt: string | undefined;
  /** Whether the initial prompt has already been delivered to some worker. */
  initialPromptDelivered: boolean | undefined;
}

/**
 * Resolve a caller's startup preference plus the worker/session's
 * initial-prompt obligation into a single `StartupIntent`. Pure: no
 * filesystem, no DB, no clock.
 *
 * Obligation = this worker is eligible, a non-empty initial prompt exists,
 * and it has not already been delivered. Verbatim the pre-refactor redelivery
 * gate (`worker-lifecycle-manager.ts` `shouldRedeliverInitialPrompt`) minus
 * its `continueConversation === false` conjunct, which preference now encodes.
 */
export function resolveStartupIntent(
  preference: StartupIntentPreference,
  input: StartupIntentInput,
): StartupIntent {
  const obligated =
    input.deliverInitialPromptOnActivation &&
    !!input.initialPrompt?.trim() &&
    input.initialPromptDelivered !== true;

  switch (preference) {
    case 'continue':
      return 'continue';
    case 'fresh':
      return obligated ? 'deliver-initial-prompt' : 'fresh';
    case 'system':
      return obligated ? 'deliver-initial-prompt' : 'continue';
  }
}
