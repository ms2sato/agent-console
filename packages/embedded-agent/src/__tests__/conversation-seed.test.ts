import { describe, it, expect } from 'bun:test';
import { buildCompactionSeedMessages, buildRestoreFailureSeedMessages } from '../conversation-seed.js';

describe('buildCompactionSeedMessages', () => {
  it("returns a system message followed by a user message carrying the distillation, coverage 'full'", () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text', 'full');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'Summary of the earlier part of this conversation, which has been compacted away: the summary text',
      },
    ]);
  });

  it("produces a well-formed seed pair with the literal empty string embedded when distillation is empty, coverage 'full'", () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', '', 'full');
    expect(seed).toEqual([
      { role: 'system', content: 'SYSTEM_PROMPT' },
      {
        role: 'user',
        content: 'Summary of the earlier part of this conversation, which has been compacted away: ',
      },
    ]);
  });

  // Coverage 'partial' must state plainly that earlier content was
  // discarded -- no soft language, no ambiguity.
  it("coverage 'partial' states the summary covers only the most recent portion and earlier content was discarded", () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text', 'partial');
    const userMessage = seed[1];
    expect(userMessage.content).toContain('only the most recent portion');
    expect(userMessage.content).toContain('discarded');
    expect(userMessage.content).toContain('the summary text');
    // Negative control: must NOT carry the full-coverage claim.
    expect(userMessage.content).not.toContain('the earlier part of this conversation, which has been compacted away');
  });

  // The sharpest edge: an ABSENT coverage (every row persisted before this
  // field existed, and every `context-handoff` boundary) must fall to a
  // THIRD, neutral phrasing -- never to the 'full' branch by accident, and
  // never inventing a 'discarded' claim it cannot support either.
  it('coverage undefined (legacy row) uses neutral phrasing with NO totality claim of either shape', () => {
    const seed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text', undefined);
    const userMessage = seed[1];
    expect(userMessage.content).toContain('the summary text');
    // Neither the 'full' claim ("covers everything before it") nor the
    // 'partial' claim ("only the most recent portion" / "discarded") may
    // appear -- absence must not be laundered into either extreme.
    expect(userMessage.content).not.toContain('the earlier part of this conversation, which has been compacted away');
    expect(userMessage.content).not.toContain('only the most recent portion');
    expect(userMessage.content).not.toContain('discarded');
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
    const compactionSeed = buildCompactionSeedMessages('SYSTEM_PROMPT', 'the summary text', 'full');
    const compactionText = compactionSeed.map((m) => m.content).join('\n');
    expect(compactionText).toContain('Summary of the earlier part');
  });
});
