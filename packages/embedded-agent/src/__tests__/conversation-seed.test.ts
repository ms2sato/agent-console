import { describe, it, expect } from 'bun:test';
import { buildHandoffSeedMessages } from '../conversation-seed.js';

describe('buildHandoffSeedMessages', () => {
  it('returns a system message followed by a user message carrying the distillation', () => {
    const seed = buildHandoffSeedMessages('SYSTEM_PROMPT', 'the summary text');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'This conversation continues from a previous one. Prior context summary: the summary text',
      },
    ]);
  });

  it('produces a well-formed seed pair with the literal empty string embedded when distillation is empty', () => {
    const seed = buildHandoffSeedMessages('SYSTEM_PROMPT', '');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'This conversation continues from a previous one. Prior context summary: ',
      },
    ]);
  });
});
