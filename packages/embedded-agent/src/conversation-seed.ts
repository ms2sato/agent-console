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
 * previous one"). The seed is a prompt to the model, not a historical
 * record: what it must describe accurately is the situation the model is in
 * NOW, and after a restore that situation is identical either way -- a
 * conversation whose head is a summary. See
 * docs/design/embedded-agent-worker.md "Compaction boundary" for the full
 * reasoning behind not branching here.
 */
export function buildCompactionSeedMessages(systemPrompt: string, summary: string): ChatMessage[] {
  const seedText = `Summary of the earlier part of this conversation, which has been compacted away: ${summary}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: seedText },
  ];
}
