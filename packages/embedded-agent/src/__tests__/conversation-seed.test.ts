import { describe, it, expect } from 'bun:test';
import { buildCompactionSeedMessages, buildRestoreFailureSeedMessages } from '../conversation-seed.js';

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

describe('buildRestoreFailureSeedMessages', () => {
  it('returns ONLY a system message -- no user-role summary message at all', () => {
    const seed = buildRestoreFailureSeedMessages('SYSTEM_PROMPT');
    expect(seed).toEqual([{ role: 'system', content: 'SYSTEM_PROMPT' }]);
  });

  // R2 addendum pin: the restore-failure seed must never carry the
  // compaction wording, WITH a presence control in the same test -- a
  // compaction-boundary seed built in the same test still carries it.
  // Without the control, changing (or removing) the phrase would make both
  // assertions pass vacuously.
  //
  // MUTATION MEASURED: swapping this function's body for
  // `buildCompactionSeedMessages(systemPrompt, '')` fails the absence
  // assertion below (`toContain` finds the phrase in the resulting seed's
  // joined content). Reach recorded here: this test is what fails.
  it('carries NO "Summary of the earlier part" text, with a presence control from the compaction seed builder', () => {
    const restoreFailureSeed = buildRestoreFailureSeedMessages('SYSTEM_PROMPT');
    const restoreFailureText = restoreFailureSeed.map((m) => m.content).join('\n');
    expect(restoreFailureText).not.toContain('Summary of the earlier part');

    // Presence control: the compaction path DOES carry the phrase.
    const compactionSeed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text');
    const compactionText = compactionSeed.map((m) => m.content).join('\n');
    expect(compactionText).toContain('Summary of the earlier part');
  });
});
