/**
 * Pure-function pins for `scripts/smoke/probe-sdk-auto-memory.ts`.
 *
 * The probe is billable and needs a real, authenticated `claude` CLI, so its
 * measurement is never run here. `exitCodeFor` / `classifyArmA` /
 * `classifyArmC` / `classifyArmD` / `redactRecallEntry` / `recallPathMatches`
 * / `summarizeRecalls` are pure -- they read only plain
 * booleans/strings/synthetic recall objects, no I/O -- and importing the
 * module runs nothing (the `import.meta.main` guard at the foot of that
 * file, covered separately by `import-safety.test.ts`), so all seven are
 * testable at zero cost and separately from what they classify.
 */
import { describe, it, expect } from 'bun:test';
import {
  PROBE_EXIT,
  exitCodeFor,
  classifyArmA,
  classifyArmC,
  classifyArmD,
  redactRecallEntry,
  recallPathMatches,
  summarizeRecalls,
  type ArmAInput,
  type ArmCInput,
  type ArmDInput,
} from '../probe-sdk-auto-memory.js';

describe('probe-sdk-auto-memory exit codes', () => {
  it('assigns each outcome a distinct code, matching the Issue spec (0/1/2)', () => {
    expect(new Set([PROBE_EXIT.OK, PROBE_EXIT.INCONCLUSIVE, PROBE_EXIT.HARNESS]).size).toBe(3);
    expect(PROBE_EXIT.OK).toBe(0);
    expect(PROBE_EXIT.INCONCLUSIVE).toBe(1);
    expect(PROBE_EXIT.HARNESS).toBe(2);
  });

  // Boundary values per design-principles.md: empty input, single element,
  // all-success, all-failure, mixed.
  it('exits INCONCLUSIVE on an empty result set (vacuous truth trap)', () => {
    expect(exitCodeFor([])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('exits OK when every arm concluded (single element and multi-element, all-success)', () => {
    expect(exitCodeFor([{ conclusive: true }])).toBe(PROBE_EXIT.OK);
    expect(exitCodeFor([{ conclusive: true }, { conclusive: true }, { conclusive: true }])).toBe(PROBE_EXIT.OK);
  });

  it('exits INCONCLUSIVE when every arm is inconclusive (all-failure)', () => {
    expect(exitCodeFor([{ conclusive: false }])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([{ conclusive: false }, { conclusive: false }])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('exits INCONCLUSIVE when any single arm is inconclusive (mixed)', () => {
    expect(exitCodeFor([{ conclusive: true }, { conclusive: false }, { conclusive: true }])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });
});

describe('classifyArmA', () => {
  const base: ArmAInput = {
    settled: true,
    expectNoRecall: false,
    measRecallHit: false,
    measTextHit: false,
    ctrlRecallHit: false,
    ctrlTextHit: false,
  };

  it('is inconclusive when a turn did not settle, before anything else is checked', () => {
    const r = classifyArmA({ ...base, settled: false, measRecallHit: true, measTextHit: true });
    expect(r.conclusive).toBe(false);
    expect(r.premise).toBeNull();
  });

  it('is inconclusive when the negative-control cwd itself recalls or answers with the nonce (positive control failed)', () => {
    expect(classifyArmA({ ...base, ctrlRecallHit: true }).conclusive).toBe(false);
    expect(classifyArmA({ ...base, ctrlTextHit: true }).conclusive).toBe(false);
    // The control failure gates the reading even when the seeded side looks like a hit.
    expect(classifyArmA({ ...base, ctrlTextHit: true, measRecallHit: true, measTextHit: true }).conclusive).toBe(false);
  });

  it('reads RECALL WORKS when either observable hits and the control stayed silent', () => {
    expect(classifyArmA({ ...base, measRecallHit: true, measTextHit: true })).toMatchObject({ conclusive: true, premise: 'holds' });
    expect(classifyArmA({ ...base, measRecallHit: true, measTextHit: false })).toMatchObject({ conclusive: true, premise: 'holds' });
    expect(classifyArmA({ ...base, measRecallHit: false, measTextHit: true })).toMatchObject({ conclusive: true, premise: 'holds' });
  });

  it('reads RECALL DOES NOT WORK when neither observable hits and the control stayed silent (all-failure boundary)', () => {
    expect(classifyArmA(base)).toMatchObject({ conclusive: true, premise: 'refuted' });
  });

  it('--expect-no-recall: confirms absence when nothing surfaces despite the skip', () => {
    const r = classifyArmA({ ...base, expectNoRecall: true });
    expect(r).toMatchObject({ conclusive: true, premise: null });
    expect(r.note).toStartWith('CONFIRMED ABSENCE');
  });

  it('--expect-no-recall: reports a polarity failure when the nonce surfaces anyway', () => {
    const r1 = classifyArmA({ ...base, expectNoRecall: true, measRecallHit: true });
    const r2 = classifyArmA({ ...base, expectNoRecall: true, measTextHit: true });
    expect(r1).toMatchObject({ conclusive: false, premise: null });
    expect(r2).toMatchObject({ conclusive: false, premise: null });
    expect(r1.note).toStartWith('POLARITY FAILURE');
  });
});

describe('classifyArmC', () => {
  const base: ArmCInput = {
    settled: true,
    slugFound: true,
    expectNoWrite: false,
    contentFound: false,
    elapsedMs: 1000,
    timeoutMs: 60_000,
  };

  it('is inconclusive when the turn did not settle', () => {
    expect(classifyArmC({ ...base, settled: false }).conclusive).toBe(false);
  });

  it('reads WRITE DOES NOT WORK when no project directory ever appears (single element / no slug boundary)', () => {
    const r = classifyArmC({ ...base, slugFound: false, contentFound: false });
    expect(r).toMatchObject({ conclusive: true, premise: 'refuted' });
  });

  it('reads WRITE WORKS when the nonce is found within the timeout', () => {
    const r = classifyArmC({ ...base, contentFound: true, filePath: '/tmp/x/memory/fact.md' });
    expect(r).toMatchObject({ conclusive: true, premise: 'holds' });
    expect(r.note).toContain('/tmp/x/memory/fact.md');
  });

  it('reads WRITE DOES NOT WORK when a slug appeared (transcript) but content never did', () => {
    const r = classifyArmC({ ...base, slugFound: true, contentFound: false });
    expect(r).toMatchObject({ conclusive: true, premise: 'refuted' });
  });

  it('--expect-no-write: confirms absence when nothing appears', () => {
    const r = classifyArmC({ ...base, expectNoWrite: true, contentFound: false });
    expect(r).toMatchObject({ conclusive: true, premise: null });
    expect(r.note).toStartWith('CONFIRMED ABSENCE');
  });

  it('--expect-no-write: reports a polarity failure when content appears anyway', () => {
    const r = classifyArmC({ ...base, expectNoWrite: true, contentFound: true, filePath: '/tmp/x/memory/surprise.md' });
    expect(r).toMatchObject({ conclusive: false, premise: null });
    expect(r.note).toStartWith('POLARITY FAILURE');
  });
});

describe('classifyArmD', () => {
  const settledRead = { settled: true, recallHit: true, textHit: true };
  const settledWrite = { settled: true, writeFound: true, defaultLeaked: false };

  it('is inconclusive when either sub-test did not settle', () => {
    const input1: ArmDInput = { read: { ...settledRead, settled: false }, write: settledWrite };
    const input2: ArmDInput = { read: settledRead, write: { ...settledWrite, settled: false } };
    expect(classifyArmD(input1).conclusive).toBe(false);
    expect(classifyArmD(input2).conclusive).toBe(false);
  });

  it('reads REDIRECT WORKS only when read works, write works, and the write did not also leak to the default (all-success)', () => {
    const r = classifyArmD({ read: settledRead, write: settledWrite });
    expect(r).toMatchObject({ conclusive: true, premise: 'holds' });
  });

  it('reads REDIRECT DOES NOT FULLY WORK when read fails (all-failure boundary: neither half works)', () => {
    const r = classifyArmD({
      read: { settled: true, recallHit: false, textHit: false },
      write: { settled: true, writeFound: false, defaultLeaked: false },
    });
    expect(r).toMatchObject({ conclusive: true, premise: 'refuted' });
    expect(r.note).toContain('read did NOT recall');
    expect(r.note).toContain('write did NOT appear');
  });

  it('reads REDIRECT DOES NOT FULLY WORK when write worked but also leaked to the default location (mixed)', () => {
    const r = classifyArmD({ read: settledRead, write: { settled: true, writeFound: true, defaultLeaked: true } });
    expect(r).toMatchObject({ conclusive: true, premise: 'refuted' });
    expect(r.note).toContain('ALSO leaked to the default location');
  });

  it('reads REDIRECT DOES NOT FULLY WORK when only the read half works', () => {
    const r = classifyArmD({ read: settledRead, write: { settled: true, writeFound: false, defaultLeaked: false } });
    expect(r.premise).toBe('refuted');
    expect(r.note).not.toContain('read did NOT recall');
    expect(r.note).toContain('write did NOT appear');
  });

  /**
   * CodeRabbit finding (PR #1662): `writeFound: false, defaultLeaked: true`
   * is reachable (the write landed at the default location INSTEAD of the
   * override -- the strongest possible evidence redirection failed) but the
   * pre-fix note only said "write did NOT appear at the override", dropping
   * the leak entirely. This is the case the suite was missing before this
   * fix -- see the Orchestrator's reach measurement in the PR body/commit.
   */
  it('reports the default-location hit even when the override write never landed (writeFound=false, defaultLeaked=true)', () => {
    const r = classifyArmD({ read: settledRead, write: { settled: true, writeFound: false, defaultLeaked: true } });
    expect(r).toMatchObject({ conclusive: true, premise: 'refuted' });
    expect(r.note).toContain('appeared at the DEFAULT location instead of the override');
    expect(r.note).toContain('write did NOT appear at the override');
  });
});

describe('redactRecallEntry', () => {
  const configDir = '/tmp/probe-sdk-automem-xyz';

  it('reports a basename and withinIsolatedConfigDir=true for a path under the isolated config dir', () => {
    const r = redactRecallEntry({ path: `${configDir}/projects/slug/memory/fact.md`, scope: 'personal' }, configDir);
    expect(r).toEqual({ scope: 'personal', withinIsolatedConfigDir: true, pathBasename: 'fact.md' });
  });

  it('redacts the path entirely for a path outside the isolated config dir (real leak)', () => {
    const r = redactRecallEntry({ path: '/home/real-user/.claude/agent-memory/personal/fact.md', scope: 'personal' }, configDir);
    expect(r.withinIsolatedConfigDir).toBe(false);
    expect(r.pathBasename).toBe('(redacted -- outside isolated CLAUDE_CONFIG_DIR)');
    // Never leak any fragment of the real path.
    expect(r.pathBasename).not.toContain('real-user');
    expect(r.pathBasename).not.toContain('fact.md');
  });

  /**
   * CodeRabbit finding (PR #1662): a raw `startsWith` has no separator
   * boundary, so a SIBLING path that merely shares the prefix string (e.g.
   * `${configDir}-evil`) would be misreported as contained. Neither
   * `configDir` nor the entry path exists on disk in this test, so
   * `resolvedOrSelf` falls back to the raw strings -- this test is exactly
   * what exercises the separator-boundary fix at that fallback layer.
   */
  it('does not treat a sibling path sharing the raw prefix as contained (separator-boundary check)', () => {
    const r = redactRecallEntry({ path: `${configDir}-evil/fact.md`, scope: 'personal' }, configDir);
    expect(r.withinIsolatedConfigDir).toBe(false);
    expect(r.pathBasename).toBe('(redacted -- outside isolated CLAUDE_CONFIG_DIR)');
  });

  it('never returns a content field, for either scope shape (organization scope carries a URL path)', () => {
    const within = redactRecallEntry({ path: `${configDir}/projects/slug/memory/fact.md`, scope: 'team' }, configDir);
    const outside = redactRecallEntry({ path: 'https://example.invalid/org/memory', scope: 'organization' }, configDir);
    expect('content' in within).toBe(false);
    expect('content' in outside).toBe(false);
    expect(outside.withinIsolatedConfigDir).toBe(false);
  });
});

describe('recallPathMatches', () => {
  const seededPath = '/tmp/probe-sdk-automem-a-seeded/projects/slug/memory/automem-probe-seeded-fact.md';

  // Boundary: empty recall list.
  it('is false for an empty recall list', () => {
    expect(recallPathMatches([], seededPath)).toBe(false);
  });

  it('is true when the trailing slug/memory/basename suffix matches, even through a different absolute prefix', () => {
    const recalls = [{ memories: [{ path: '/some/other/resolved/root/projects/slug/memory/automem-probe-seeded-fact.md' }] }];
    expect(recallPathMatches(recalls, seededPath)).toBe(true);
  });

  /**
   * The mismatch case (Architect ruling, PR #1662): "recall happened"
   * becomes "recall happened FOR THE FORMAT WE ASSUMED" only when the
   * recalled path is the one this arm actually seeded, not an unrelated
   * memory that happened to surface in the same turn.
   */
  it('is false when a recall fired but for a DIFFERENT file in the SAME project (mismatch case)', () => {
    const recalls = [{ memories: [{ path: '/tmp/probe-sdk-automem-a-seeded/projects/slug/memory/MEMORY.md' }] }];
    expect(recallPathMatches(recalls, seededPath)).toBe(false);
  });

  /**
   * CodeRabbit follow-up finding (PR #1662): a bare basename match lets an
   * UNRELATED memory under a DIFFERENT project slug count as a hit. The
   * filename here is identical to the seeded topic file's basename; only
   * the slug segment differs, which must be enough to reject it.
   */
  it('is false when the basename matches but the project (slug) differs', () => {
    const recalls = [{ memories: [{ path: '/tmp/probe-sdk-automem-b/projects/DIFFERENT-SLUG/memory/automem-probe-seeded-fact.md' }] }];
    expect(recallPathMatches(recalls, seededPath)).toBe(false);
  });

  it('is false when the suffix is too short to have a slug segment at all (a bare basename report)', () => {
    const recalls = [{ memories: [{ path: '/anywhere/automem-probe-seeded-fact.md' }] }];
    expect(recallPathMatches(recalls, seededPath)).toBe(false);
  });

  it('is true when at least one of several memories in one recall matches (mixed)', () => {
    const recalls = [
      {
        memories: [
          { path: '/unrelated/one.md' },
          { path: '/anywhere/deep/slug/memory/automem-probe-seeded-fact.md' },
          { path: '/unrelated/two.md' },
        ],
      },
    ];
    expect(recallPathMatches(recalls, seededPath)).toBe(true);
  });

  it('is true when at least one of several recall events matches (mixed, all-failure-but-one)', () => {
    const recalls = [
      { memories: [{ path: '/unrelated/one.md' }] },
      { memories: [{ path: '/anywhere/deep/slug/memory/automem-probe-seeded-fact.md' }] },
    ];
    expect(recallPathMatches(recalls, seededPath)).toBe(true);
  });

  it('is false when every recall across every event misses (all-failure)', () => {
    const recalls = [{ memories: [{ path: '/unrelated/one.md' }] }, { memories: [{ path: '/unrelated/two.md' }] }];
    expect(recallPathMatches(recalls, seededPath)).toBe(false);
  });
});

describe('summarizeRecalls', () => {
  const configDir = '/tmp/probe-sdk-automem-xyz';
  /** Never a real secret in a test, but shaped like one -- the assertion is that this substring never reaches the output. */
  const SENTINEL_CONTENT = 'SENTINEL-DO-NOT-LEAK-9f3a2b1c';

  // Boundary: empty recall list.
  it('is an empty array for an empty recall list', () => {
    expect(summarizeRecalls([], configDir)).toEqual([]);
  });

  /**
   * CodeRabbit finding (PR #1662): this is the single writer for BOTH
   * `runArmB`'s summaries and `runMemorySession`'s redacted log line, so its
   * return shape is pinned at the SERIALIZATION boundary -- not just via
   * `redactRecallEntry`'s own per-entry test -- against a `content` field
   * being spread back in by a careless future edit to either call site.
   */
  it('retains mode/scope/withinIsolatedConfigDir/pathBasename and drops content entirely, for both scope shapes', () => {
    const recalls = [
      {
        mode: 'select' as const,
        memories: [
          { path: `${configDir}/projects/slug/memory/fact.md`, scope: 'personal' as const, content: SENTINEL_CONTENT },
        ],
      },
      {
        mode: 'synthesize' as const,
        memories: [{ path: 'https://example.invalid/org/memory', scope: 'organization' as const, content: SENTINEL_CONTENT }],
      },
    ];
    const result = summarizeRecalls(recalls, configDir);

    expect(result).toEqual([
      { mode: 'select', scope: 'personal', withinIsolatedConfigDir: true, pathBasename: 'fact.md' },
      { mode: 'synthesize', scope: 'organization', withinIsolatedConfigDir: false, pathBasename: '(redacted -- outside isolated CLAUDE_CONFIG_DIR)' },
    ]);
    for (const entry of result) {
      expect('content' in entry).toBe(false);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL_CONTENT);
    expect(serialized).not.toContain('content');
  });

  it('flattens multiple memories across multiple recall events, in order (mixed)', () => {
    const recalls = [
      { mode: 'select' as const, memories: [{ path: `${configDir}/a.md`, scope: 'personal' as const }, { path: '/outside/b.md', scope: 'team' as const }] },
      { mode: 'synthesize' as const, memories: [{ path: `${configDir}/c.md`, scope: 'personal' as const }] },
    ];
    const result = summarizeRecalls(recalls, configDir);
    expect(result.map((r) => r.pathBasename)).toEqual(['a.md', '(redacted -- outside isolated CLAUDE_CONFIG_DIR)', 'c.md']);
    expect(result.map((r) => r.mode)).toEqual(['select', 'select', 'synthesize']);
  });

  // Boundary: a recall event with no memories at all contributes nothing.
  it('contributes nothing for a recall event with an empty memories array', () => {
    const recalls = [{ mode: 'select' as const, memories: [] }];
    expect(summarizeRecalls(recalls, configDir)).toEqual([]);
  });
});
