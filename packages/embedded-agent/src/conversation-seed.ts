import type { ChatMessage } from './providers/types.js';

/**
 * Build the seed pair a compaction produces: a fresh system prompt plus a
 * user message carrying the summary that replaces the conversation's head.
 *
 * SINGLE WRITER of this shape, shared by three call sites that must never
 * drift: `AgentLoop.compact()` (the live path), and the restore module's two
 * boundary kinds -- `context-compacted`, and the legacy `context-handoff`
 * marker persisted before compaction replaced handoff.
 *
 * The legacy boundary deliberately gets this same compaction wording rather
 * than the retired handoff sentence ("This conversation continues from a
 * previous one"): the seed is a prompt to the model, not a historical
 * record, and after a restore the situation is identical either way -- a
 * conversation whose head is a summary. See
 * docs/design/embedded-agent-worker.md "Compaction boundary" for the full
 * reasoning behind sharing that wording.
 *
 * `coverage` branches the sentence's totality claim into three states, three
 * ways, none of which may fall through to another by accident:
 *
 * - `'full'` -- the summary covers everything before it; the only state
 *   where that claim is verified true by the caller.
 * - `'partial'` -- the summary covers only the most recent portion of a
 *   longer conversation, and states plainly that earlier content was
 *   discarded.
 * - `undefined` -- the legacy state every row written before `coverage`
 *   existed carries, and the state a `context-handoff` boundary always
 *   carries (that member has no `coverage` field at all). Neutral phrasing,
 *   no totality claim of either shape -- this is what corrects the
 *   pre-existing "the summary covers everything" overclaim for those rows.
 */
export function buildCompactionSeedMessages(
  systemPrompt: string,
  summary: string,
  coverage: 'full' | 'partial' | undefined,
): ChatMessage[] {
  const seedText = `${compactionSeedLeadIn(coverage)}${summary}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: seedText },
  ];
}

function compactionSeedLeadIn(coverage: 'full' | 'partial' | undefined): string {
  if (coverage === 'partial') {
    return 'Summary of only the most recent portion of this conversation -- earlier content was discarded and is not covered by this summary: ';
  }
  if (coverage === 'full') {
    return 'Summary of the earlier part of this conversation, which has been compacted away: ';
  }
  // Neutral, deliberately making no totality claim: this row predates the
  // `coverage` field (or is a legacy `context-handoff` boundary, which never
  // had one), so whether the summary covers everything or only a suffix is
  // genuinely unknown here.
  return 'Summary of this conversation up to this point: ';
}

/**
 * Build the seed a window opening at a `restore-failure-boundary` marker
 * reconstructs with (Transcript Restore, R2 addendum, #1447 stage 4):
 * the system prompt ONLY, no user-role summary message.
 *
 * Deliberately NOT `buildCompactionSeedMessages`: that function unconditionally
 * injects "Summary of the earlier part of this conversation, which has been
 * compacted away: " wording, fabricating the premise of a summary that never
 * existed for this boundary kind. Unlike a compaction boundary, a restore
 * failure has nothing to carry forward -- the corrupt/unparseable region
 * before the marker was never reconstructed, so there is no summary to state,
 * and inventing one would itself manufacture the exact kind of undeclared
 * divergence #1447's C2 exists to prevent.
 *
 * `restore.ts`'s `reconstructConversation` branches to this builder, by the
 * boundary event's `type`, before ever reaching `boundarySummary()` -- the
 * marker event carries no `summary` field at the type level, so calling
 * `buildCompactionSeedMessages` here would be a compile error, not a review
 * convention.
 */
export function buildRestoreFailureSeedMessages(systemPrompt: string): ChatMessage[] {
  return [{ role: 'system', content: systemPrompt }];
}
