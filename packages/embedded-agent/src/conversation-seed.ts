import type { ChatMessage } from './providers/types.js';

/**
 * Build the seed pair a context handoff produces: a fresh system prompt plus
 * a user message carrying the prior conversation's distillation. Shared by
 * `AgentLoop.handoff()` (the live call site) and the restore module (which
 * rebuilds the IDENTICAL seed shape when replay crosses a persisted
 * `context-handoff` marker) so the two can never drift -- see
 * docs/design/embedded-agent-worker.md "Context-handoff boundary".
 */
export function buildHandoffSeedMessages(systemPrompt: string, distillation: string): ChatMessage[] {
  const seedText = `This conversation continues from a previous one. Prior context summary: ${distillation}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: seedText },
  ];
}
