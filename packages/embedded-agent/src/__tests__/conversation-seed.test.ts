import { describe, it, expect } from 'bun:test';
import { buildCompactionSeedMessages } from '../conversation-seed.js';

describe('buildCompactionSeedMessages', () => {
  it('returns a system message followed by a user message carrying the distillation', () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'Summary of the earlier part of this conversation, which has been compacted away: the summary text',
      },
    ]);
  });

  it('produces a well-formed seed pair with the literal empty string embedded when distillation is empty', () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', '');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'Summary of the earlier part of this conversation, which has been compacted away: ',
      },
    ]);
  });
});
