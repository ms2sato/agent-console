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
 *
 * Task 0b (Issue #1667) adds `classifyArmEConfig` / `summarizeArmE` /
 * `resolveArmFConfigKey` / `armFHaltCheck` / `resolveExtendedTimeoutMs` /
 * `textContainsPath` / `diffMtimeSnapshots` / `resolveRealConfigDir` /
 * `isAttributableToProbe` / `classifyRealTreeDiff` (pure, same treatment)
 * and `seedMemoryTopic` (real but zero-cost, deterministic filesystem I/O
 * against a real tmpdir -- no LLM turn, no network, matching this file's
 * "Tests Must Test Production Code" convention for a helper that isn't a
 * pure function but also isn't billable).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROBE_EXIT,
  exitCodeFor,
  classifyArmA,
  classifyArmC,
  classifyArmD,
  classifyArmEConfig,
  summarizeArmE,
  formatMemoryFilesForNote,
  resolveArmFConfigKey,
  armFHaltCheck,
  resolveExtendedTimeoutMs,
  textContainsPath,
  diffMtimeSnapshots,
  resolveRealConfigDir,
  isAttributableToProbe,
  classifyRealTreeDiff,
  PROBE_SLUG,
  seedMemoryTopic,
  redactRecallEntry,
  recallPathMatches,
  summarizeRecalls,
  classifyAutoMemoryOffCheck,
  parseArgs,
  EXTENDED_TIMEOUT_CAP_MS,
  WRITE_POLL_TIMEOUT_MS,
  type ArmAInput,
  type ArmCInput,
  type ArmDInput,
  type ArmEConfigInput,
  type ArmESummaryInput,
  type AutoMemoryOffCheckInput,
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

// ---------------------------------------------------------------------------
// Task 0b (Issue #1667): Arm E awareness classification
// ---------------------------------------------------------------------------

describe('classifyArmEConfig', () => {
  it('is inconclusive when the turn did not settle, before anything else is checked', () => {
    const r = classifyArmEConfig({ settled: false, locationHit: true, accessHit: true });
    expect(r.conclusive).toBe(false);
    expect(r.classification).toBe('unaware');
  });

  it('reads aware-and-reading when both observables hit (all-success boundary)', () => {
    const r = classifyArmEConfig({ settled: true, locationHit: true, accessHit: true });
    expect(r).toMatchObject({ classification: 'aware-and-reading', conclusive: true });
  });

  it('reads aware-prose-only when only ACCESS hits -- NOT absence', () => {
    const r = classifyArmEConfig({ settled: true, locationHit: false, accessHit: true });
    expect(r).toMatchObject({ classification: 'aware-prose-only', conclusive: true });
    expect(r.note).toContain('NOT absence');
  });

  it('reads told-not-read when only LOCATION hits', () => {
    const r = classifyArmEConfig({ settled: true, locationHit: true, accessHit: false });
    expect(r).toMatchObject({ classification: 'told-not-read', conclusive: true });
  });

  it('reads unaware when neither observable hits (all-failure boundary)', () => {
    const r = classifyArmEConfig({ settled: true, locationHit: false, accessHit: false });
    expect(r).toMatchObject({ classification: 'unaware', conclusive: true });
  });
});

describe('formatMemoryFilesForNote', () => {
  // Boundary: no entries.
  it('reports an empty array for zero entries', () => {
    expect(formatMemoryFilesForNote([])).toBe('memoryFiles=[]');
  });

  it('reports an empty array when entries is undefined (boundary)', () => {
    expect(formatMemoryFilesForNote(undefined)).toBe('memoryFiles=[]');
  });

  it('formats a single entry with path/type/tokens', () => {
    expect(formatMemoryFilesForNote([{ path: '/tmp/x/MEMORY.md', type: 'Project', tokens: 42 }])).toBe(
      'memoryFiles=[{path=/tmp/x/MEMORY.md, type=Project, tokens=42}]',
    );
  });

  it('formats multiple entries, comma-separated, in order (mixed)', () => {
    const r = formatMemoryFilesForNote([
      { path: '/tmp/x/MEMORY.md', type: 'Project', tokens: 42 },
      { path: '/tmp/x/other.md', type: 'User', tokens: 7 },
    ]);
    expect(r).toBe('memoryFiles=[{path=/tmp/x/MEMORY.md, type=Project, tokens=42}, {path=/tmp/x/other.md, type=User, tokens=7}]');
  });
});

describe('summarizeArmE', () => {
  const unaware: ArmEConfigInput = { settled: true, locationHit: false, accessHit: false };
  const aware: ArmEConfigInput = { settled: true, locationHit: true, accessHit: true };
  const accessOnly: ArmEConfigInput = { settled: true, locationHit: false, accessHit: true };

  const allUnaware: ArmESummaryInput = { omitted: unaware, preset: unaware, presetExcluded: unaware };

  it("folds each configuration's memoryFiles entries into the note (Architect request, PR #1676 review)", () => {
    const withMemoryFiles: ArmEConfigInput = { ...aware, memoryFilesEntries: [{ path: '/tmp/x/MEMORY.md', type: 'Project', tokens: 42 }] };
    const s = summarizeArmE({ omitted: withMemoryFiles, preset: unaware, presetExcluded: unaware });
    expect(s.note).toContain('memoryFiles=[{path=/tmp/x/MEMORY.md, type=Project, tokens=42}]');
  });

  it('folds an empty memoryFiles note when a configuration reports none (boundary)', () => {
    const s = summarizeArmE(allUnaware);
    expect(s.note).toContain('memoryFiles=[]');
  });

  it('reports no awareness anywhere, a clean control, when every configuration is unaware (all-failure boundary)', () => {
    const s = summarizeArmE(allUnaware);
    expect(s.conclusive).toBe(true);
    expect(s.productionAware).toBe(false);
    expect(s.awareConfigs).toEqual([]);
    expect(s.controlClean).toBe(true);
  });

  it("identifies production's own shape (omitted) as aware when its ACCESS observable hits", () => {
    const s = summarizeArmE({ ...allUnaware, omitted: accessOnly });
    expect(s.productionAware).toBe(true);
    expect(s.awareConfigs).toEqual(['omitted']);
  });

  it('identifies preset as aware without crediting production when only preset hits (mixed)', () => {
    const s = summarizeArmE({ ...allUnaware, preset: aware });
    expect(s.productionAware).toBe(false);
    expect(s.awareConfigs).toEqual(['preset']);
  });

  it('lists both awareConfigs when both (i) and (ii) show awareness (all-success boundary)', () => {
    const s = summarizeArmE({ omitted: aware, preset: aware, presetExcluded: unaware });
    expect(s.awareConfigs).toEqual(['omitted', 'preset']);
  });

  /**
   * Architect ruling, PR #1676 review: LOCATION awareness alone
   * (`told-not-read` -- the model was told the path but did not recall the
   * seeded title) counts as "shows awareness" for arm F's own premise, even
   * though ACCESS itself missed. The code already did this
   * (`classification !== 'unaware'`); this pins it explicitly so a future
   * edit narrowing to ACCESS-only breaks a test, not just a comment.
   */
  it('counts told-not-read (LOCATION only) as awareness, not just ACCESS', () => {
    const locationOnly: ArmEConfigInput = { settled: true, locationHit: true, accessHit: false };
    const s = summarizeArmE({ ...allUnaware, omitted: locationOnly });
    expect(s.perConfig.omitted.classification).toBe('told-not-read');
    expect(s.productionAware).toBe(true);
    expect(s.awareConfigs).toEqual(['omitted']);
  });

  it('reports control: NONE AVAILABLE when the (iii) negative control itself surfaces an observable', () => {
    const s = summarizeArmE({ ...allUnaware, presetExcluded: accessOnly });
    expect(s.controlClean).toBe(false);
    expect(s.note).toContain('NONE AVAILABLE');
  });

  it('reports controlClean=null when the (iii) control turn did not settle', () => {
    const s = summarizeArmE({ ...allUnaware, presetExcluded: { settled: false, locationHit: false, accessHit: false } });
    expect(s.controlClean).toBeNull();
  });

  it('is inconclusive overall when any single configuration did not settle (mixed)', () => {
    const s = summarizeArmE({ ...allUnaware, preset: { settled: false, locationHit: false, accessHit: false } });
    expect(s.conclusive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 0b: Arm F configuration selection + Arm G timeout resolution
// ---------------------------------------------------------------------------

describe('resolveArmFConfigKey', () => {
  const unaware: ArmEConfigInput = { settled: true, locationHit: false, accessHit: false };
  const accessOnly: ArmEConfigInput = { settled: true, locationHit: false, accessHit: true };

  it('honors an explicit --f-config override regardless of the Arm E summary', () => {
    const s = summarizeArmE({ omitted: accessOnly, preset: unaware, presetExcluded: unaware });
    const r = resolveArmFConfigKey(s, 'preset');
    expect(r.key).toBe('preset');
    expect(r.source).toContain('override');
  });

  it('defaults to omitted when Arm E did not run in this invocation (no summary, no override)', () => {
    const r = resolveArmFConfigKey(null, undefined);
    expect(r.key).toBe('omitted');
    expect(r.source).toContain('no Arm E result');
  });

  it("prefers (i) omitted when it shows awareness, per the Issue's own rule", () => {
    const s = summarizeArmE({ omitted: accessOnly, preset: accessOnly, presetExcluded: unaware });
    const r = resolveArmFConfigKey(s, undefined);
    expect(r.key).toBe('omitted');
  });

  it('falls back to (ii) preset when only it shows awareness', () => {
    const s = summarizeArmE({ omitted: unaware, preset: accessOnly, presetExcluded: unaware });
    const r = resolveArmFConfigKey(s, undefined);
    expect(r.key).toBe('preset');
  });

  it('defaults to omitted, with a distinguishing source, when neither shows awareness (all-failure boundary)', () => {
    const s = summarizeArmE({ omitted: unaware, preset: unaware, presetExcluded: unaware });
    const r = resolveArmFConfigKey(s, undefined);
    expect(r.key).toBe('omitted');
    expect(r.source).toContain('neither');
  });
});

describe('armFHaltCheck', () => {
  const cleanUnaware: ArmESummaryInput = {
    omitted: { settled: true, locationHit: false, accessHit: false },
    preset: { settled: true, locationHit: false, accessHit: false },
    presetExcluded: { settled: true, locationHit: false, accessHit: false },
  };
  const cleanAware: ArmESummaryInput = { ...cleanUnaware, omitted: { settled: true, locationHit: false, accessHit: true } };
  const dirtyControl: ArmESummaryInput = { ...cleanAware, presetExcluded: { settled: true, locationHit: false, accessHit: true } };
  const unsettledControl: ArmESummaryInput = { ...cleanAware, presetExcluded: { settled: false, locationHit: false, accessHit: false } };

  it('does not halt when Arm E did not run in this invocation (boundary: null summary)', () => {
    const r = armFHaltCheck(null, false);
    expect(r.halt).toBe(false);
  });

  it("does not halt regardless of Arm E's summary when --force-f overrides", () => {
    const r = armFHaltCheck(summarizeArmE(cleanUnaware), true);
    expect(r.halt).toBe(false);
    expect(r.reason).toContain('override');
  });

  it('halts when no configuration shows awareness, even with a clean control (all-failure boundary)', () => {
    const r = armFHaltCheck(summarizeArmE(cleanUnaware), false);
    expect(r.halt).toBe(true);
    expect(r.reason).toContain('untestable');
  });

  it('does not halt when at least one configuration shows awareness and the control is clean (all-success boundary)', () => {
    const r = armFHaltCheck(summarizeArmE(cleanAware), false);
    expect(r.halt).toBe(false);
  });

  /**
   * Architect ruling, PR #1676 review: a dirty (iii) control does NOT halt
   * -- excludeDynamicSections is documented to re-inject stripped content
   * as the first user message, so (iii) surfacing an observable is the
   * EXPECTED result on a doc-conformant build, not evidence F cannot run.
   */
  it('does NOT halt when the (iii) control is not clean, as long as a configuration shows awareness (mixed)', () => {
    const r = armFHaltCheck(summarizeArmE(dirtyControl), false);
    expect(r.halt).toBe(false);
    expect(r.reason).toContain('EXPECTED');
  });

  it('does NOT halt when the (iii) control turn never settled, as long as a configuration shows awareness', () => {
    const r = armFHaltCheck(summarizeArmE(unsettledControl), false);
    expect(r.halt).toBe(false);
  });
});

describe('resolveExtendedTimeoutMs', () => {
  it("behaves exactly like Arm F's 60s poll when omitted (boundary: undefined)", () => {
    expect(resolveExtendedTimeoutMs(undefined)).toBe(WRITE_POLL_TIMEOUT_MS);
  });

  it("behaves exactly like Arm F's 60s poll when 0 (boundary: explicit zero)", () => {
    expect(resolveExtendedTimeoutMs(0)).toBe(WRITE_POLL_TIMEOUT_MS);
  });

  it('passes through a value within the owner-directive cap unchanged', () => {
    expect(resolveExtendedTimeoutMs(120_000)).toBe(120_000);
  });

  it('passes through exactly the cap unchanged (boundary)', () => {
    expect(resolveExtendedTimeoutMs(EXTENDED_TIMEOUT_CAP_MS)).toBe(EXTENDED_TIMEOUT_CAP_MS);
  });

  it('clamps a value over the owner-directive cap (binding: never exceeds 5 minutes)', () => {
    expect(resolveExtendedTimeoutMs(999_999)).toBe(EXTENDED_TIMEOUT_CAP_MS);
    expect(EXTENDED_TIMEOUT_CAP_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Task 0b: textContainsPath
// ---------------------------------------------------------------------------

describe('textContainsPath', () => {
  it('is true when the text contains the raw path verbatim', () => {
    expect(textContainsPath('the path is /tmp/foo/bar', '/tmp/foo/bar')).toBe(true);
  });

  it('is false when the text contains neither the raw nor a resolved form (all-failure boundary)', () => {
    expect(textContainsPath('I do not know', '/tmp/foo/bar')).toBe(false);
  });

  it('is false for an empty text (boundary)', () => {
    expect(textContainsPath('', '/tmp/foo/bar')).toBe(false);
  });

  it('is true via the resolved (symlink-following) form even when the raw path never appears', async () => {
    const fs = await import('node:fs');
    const real = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-textpath-real-'));
    const linkDir = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-textpath-link-'));
    const linkPath = join(linkDir, 'memory');
    try {
      fs.symlinkSync(real, linkPath, 'dir');
      const resolved = fs.realpathSync(linkPath);
      // The text mentions only the RESOLVED path, never the symlink path --
      // this is exactly the shape a spawned CLI can produce (macOS's /var ->
      // /private/var), which is why this branch exists at all.
      expect(textContainsPath(`the memory directory is ${resolved}`, linkPath)).toBe(true);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(real, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 0b: diffMtimeSnapshots (real config-location cross-check)
// ---------------------------------------------------------------------------

describe('diffMtimeSnapshots', () => {
  // Boundary: both empty.
  it('reports nothing for two empty snapshots', () => {
    expect(diffMtimeSnapshots(new Map(), new Map())).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports an added path present only in the after snapshot', () => {
    const before = new Map<string, number>();
    const after = new Map([['/a', 100]]);
    expect(diffMtimeSnapshots(before, after)).toEqual({ added: ['/a'], removed: [], changed: [] });
  });

  it('reports a removed path present only in the before snapshot', () => {
    const before = new Map([['/a', 100]]);
    const after = new Map<string, number>();
    expect(diffMtimeSnapshots(before, after)).toEqual({ added: [], removed: ['/a'], changed: [] });
  });

  it('reports a changed path whose mtime differs between snapshots', () => {
    const before = new Map([['/a', 100]]);
    const after = new Map([['/a', 200]]);
    expect(diffMtimeSnapshots(before, after)).toEqual({ added: [], removed: [], changed: ['/a'] });
  });

  it('reports nothing for an unchanged path (single-element, no-op boundary)', () => {
    const before = new Map([['/a', 100]]);
    const after = new Map([['/a', 100]]);
    expect(diffMtimeSnapshots(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports all three kinds together (mixed, this cross-check\'s own canary shape)', () => {
    const before = new Map([
      ['/kept', 100],
      ['/removed', 100],
      ['/changed', 100],
    ]);
    const after = new Map([
      ['/kept', 100],
      ['/changed', 200],
      ['/added', 300],
    ]);
    expect(diffMtimeSnapshots(before, after)).toEqual({ added: ['/added'], removed: ['/removed'], changed: ['/changed'] });
  });
});

// ---------------------------------------------------------------------------
// Task 0b: resolveRealConfigDir
// ---------------------------------------------------------------------------

describe('resolveRealConfigDir', () => {
  it('uses CLAUDE_CONFIG_DIR when the env var is already set', () => {
    expect(resolveRealConfigDir({ CLAUDE_CONFIG_DIR: '/custom/config' }, '/home/someone')).toBe('/custom/config');
  });

  it("falls back to ~/.claude when the env var is unset (measure, don't assume, boundary)", () => {
    expect(resolveRealConfigDir({}, '/home/someone')).toBe(join('/home/someone', '.claude'));
  });

  it('falls back to ~/.claude when the env var is set to an empty string (boundary)', () => {
    expect(resolveRealConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/someone')).toBe(join('/home/someone', '.claude'));
  });
});

// ---------------------------------------------------------------------------
// Task 0b (Architect ruling, PR #1676 review): real-tree attribution filter
// ---------------------------------------------------------------------------

describe('isAttributableToProbe', () => {
  const nonces = new Set(['NONCE-A', 'NONCE-B']);

  it('is true when the path itself contains the probe slug', () => {
    expect(isAttributableToProbe({ path: `/home/x/.claude/${PROBE_SLUG}-canary-RUN-1.tmp`, content: null }, PROBE_SLUG, nonces)).toBe(true);
  });

  it('is true when a nonce appears in the content of a path WITH a memory/ segment (the real leak shape)', () => {
    expect(isAttributableToProbe({ path: '/home/x/.claude/projects/some-slug/memory/leaked.md', content: 'saw NONCE-A in the turn' }, PROBE_SLUG, nonces)).toBe(true);
  });

  /**
   * Architect ruling round 2, PR #1676 review: this probe prints every
   * nonce to stdout, and the delegate session RUNNING it ingests that
   * stdout as its own tool output, writing it into ITS OWN transcript
   * .jsonl under the same real config dir. An unscoped nonce-content match
   * (this test's shape, pre-fix) made that transcript "attributable" and
   * would false-escalate on every single run -- Task 0's own manual
   * addendum saw exactly this and dismissed it because it was NOT under a
   * memory/ subdirectory. This test was WRONG before the fix (it asserted
   * `true`); it now pins the corrected behavior.
   */
  it('is false when a nonce appears in the content of a path with NO memory/ segment (the operator-transcript-echo shape)', () => {
    expect(isAttributableToProbe({ path: '/home/x/.claude/projects/some-slug/transcript.jsonl', content: 'saw NONCE-A in the turn' }, PROBE_SLUG, nonces)).toBe(false);
  });

  it('is false for an unrelated path with no content (a removed path, boundary)', () => {
    expect(isAttributableToProbe({ path: '/home/x/.claude/file-history/backup.json', content: null }, PROBE_SLUG, nonces)).toBe(false);
  });

  it('is false for a memory/-segmented path whose content matches no nonce (all-failure boundary)', () => {
    expect(isAttributableToProbe({ path: '/home/x/.claude/projects/other/memory/fact.md', content: 'ordinary conversation' }, PROBE_SLUG, nonces)).toBe(false);
  });

  it('is false against an empty nonce set, even under memory/ (boundary: no nonces minted yet)', () => {
    expect(isAttributableToProbe({ path: '/home/x/.claude/projects/x/memory/fact.md', content: 'NONCE-A' }, PROBE_SLUG, new Set())).toBe(false);
  });
});

describe('classifyRealTreeDiff', () => {
  const nonces = new Set(['NONCE-A']);
  const canaryPath = `/home/x/.claude/${PROBE_SLUG}-canary-RUN-1.tmp`;

  // Boundary: empty diff.
  it('reports zero attributable, zero unrelated, zero nonce echoes for an empty diff', () => {
    const r = classifyRealTreeDiff({ added: [], removed: [], changed: [] }, new Map(), PROBE_SLUG, nonces);
    expect(r).toEqual({ attributable: { added: [], removed: [], changed: [] }, unrelatedCount: 0, nonceEchoOutsideMemoryCount: 0 });
  });

  it('classifies the canary itself as attributable via the slug (the positive control shape)', () => {
    const diff = { added: [canaryPath], removed: [], changed: [] };
    const checks = new Map([[canaryPath, { path: canaryPath, content: 'canary content' }]]);
    const r = classifyRealTreeDiff(diff, checks, PROBE_SLUG, nonces);
    expect(r.attributable.added).toEqual([canaryPath]);
    expect(r.unrelatedCount).toBe(0);
  });

  it('buckets an unrelated concurrent-session path (no slug, no nonce) as unrelated, not attributable (all-failure boundary)', () => {
    const otherTranscript = '/home/x/.claude/projects/other-session/transcript.jsonl';
    const diff = { added: [], removed: [], changed: [otherTranscript] };
    const checks = new Map([[otherTranscript, { path: otherTranscript, content: 'unrelated chatter' }]]);
    const r = classifyRealTreeDiff(diff, checks, PROBE_SLUG, nonces);
    expect(r.attributable.changed).toEqual([]);
    expect(r.unrelatedCount).toBe(1);
    expect(r.nonceEchoOutsideMemoryCount).toBe(0);
  });

  /**
   * Architect ruling round 2: the operator's own transcript echoing a run
   * nonce is unrelated (not attributable, never escalates) but reported
   * separately from silent unrelated activity, via
   * `nonceEchoOutsideMemoryCount`.
   */
  it('counts an operator-transcript nonce echo as unrelated AND reports it via nonceEchoOutsideMemoryCount', () => {
    const ownTranscript = '/home/x/.claude/projects/this-delegate/transcript.jsonl';
    const diff = { added: [], removed: [], changed: [ownTranscript] };
    const checks = new Map([[ownTranscript, { path: ownTranscript, content: 'the probe printed NONCE-A to stdout' }]]);
    const r = classifyRealTreeDiff(diff, checks, PROBE_SLUG, nonces);
    expect(r.attributable.changed).toEqual([]);
    expect(r.unrelatedCount).toBe(1);
    expect(r.nonceEchoOutsideMemoryCount).toBe(1);
  });

  it('splits a mixed diff into attributable, unrelated, and nonce-echo-outside-memory correctly (mixed)', () => {
    const leaked = '/home/x/.claude/projects/some-slug/memory/leaked.md';
    const unrelated1 = '/home/x/.claude/file-history/backup.json';
    const ownTranscript = '/home/x/.claude/projects/other-session/transcript.jsonl';
    const diff = { added: [leaked, unrelated1], removed: [], changed: [ownTranscript] };
    const checks = new Map([
      [leaked, { path: leaked, content: 'contains NONCE-A' }],
      [unrelated1, { path: unrelated1, content: null }],
      [ownTranscript, { path: ownTranscript, content: 'echoes NONCE-A but is a transcript, not memory/' }],
    ]);
    const r = classifyRealTreeDiff(diff, checks, PROBE_SLUG, nonces);
    expect(r.attributable).toEqual({ added: [leaked], removed: [], changed: [] });
    expect(r.unrelatedCount).toBe(2);
    expect(r.nonceEchoOutsideMemoryCount).toBe(1);
  });

  it('treats a path missing from the checks map as unreadable/unrelated (defensive default)', () => {
    const r = classifyRealTreeDiff({ added: ['/some/path'], removed: [], changed: [] }, new Map(), PROBE_SLUG, nonces);
    expect(r.attributable.added).toEqual([]);
    expect(r.unrelatedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 0b: seedMemoryTopic (real, zero-cost filesystem I/O -- no LLM turn)
// ---------------------------------------------------------------------------

describe('seedMemoryTopic', () => {
  let memoryDir: string;

  afterEach(() => {
    if (memoryDir) rmSync(memoryDir, { recursive: true, force: true });
  });

  it('writes a frontmatter-carrying topic file and a new MEMORY.md index when neither existed (boundary: fresh dir)', () => {
    memoryDir = join(mkdtempSync(join(tmpdir(), 'probe-sdk-automem-seed-')), 'memory');
    const { topicPath, indexPath } = seedMemoryTopic({
      memoryDir,
      topicFilename: 'fact.md',
      frontmatterName: 'fact',
      description: 'a test fact',
      codenameSubject: 'The codename',
      codenameValue: 'ZEBRA-42',
      indexTitle: 'Test Fact',
      indexHook: 'the codename is here.',
    });
    const topicContent = readFileSync(topicPath, 'utf8');
    expect(topicContent).toContain('name: fact');
    expect(topicContent).toContain('description: a test fact');
    expect(topicContent).toContain('type: project');
    expect(topicContent).toContain('The codename is ZEBRA-42.');
    const indexContent = readFileSync(indexPath, 'utf8');
    expect(indexContent).toContain('# Memory Index');
    expect(indexContent).toContain('- [Test Fact](fact.md) — the codename is here.');
  });

  it('appends to an existing MEMORY.md rather than overwriting a prior entry', () => {
    memoryDir = join(mkdtempSync(join(tmpdir(), 'probe-sdk-automem-seed-')), 'memory');
    seedMemoryTopic({
      memoryDir,
      topicFilename: 'first.md',
      frontmatterName: 'first',
      description: 'first fact',
      codenameSubject: 'The codename',
      codenameValue: 'FIRST-1',
      indexTitle: 'First Fact',
      indexHook: 'first hook.',
    });
    const { indexPath } = seedMemoryTopic({
      memoryDir,
      topicFilename: 'second.md',
      frontmatterName: 'second',
      description: 'second fact',
      codenameSubject: 'The codename',
      codenameValue: 'SECOND-2',
      indexTitle: 'Second Fact',
      indexHook: 'second hook.',
    });
    const indexContent = readFileSync(indexPath, 'utf8');
    expect(indexContent).toContain('- [First Fact](first.md) — first hook.');
    expect(indexContent).toContain('- [Second Fact](second.md) — second hook.');
  });
});

// ---------------------------------------------------------------------------
// #1681: classifyAutoMemoryOffCheck
// ---------------------------------------------------------------------------

describe('classifyAutoMemoryOffCheck', () => {
  const clean: AutoMemoryOffCheckInput = { settled: true, locationHit: false, accessHit: false, memoryFilesCount: 0 };

  it('is inconclusive when the turn did not settle, before anything else is checked', () => {
    const r = classifyAutoMemoryOffCheck({ ...clean, settled: false });
    expect(r.conclusive).toBe(false);
    expect(r.note.startsWith('INCONCLUSIVE')).toBe(true);
  });

  it('reads confirmed-off when all three observables are clean (all-success boundary)', () => {
    const r = classifyAutoMemoryOffCheck(clean);
    expect(r).toMatchObject({ classification: 'confirmed-off', conclusive: true });
  });

  it('reads unexpected-hit when LOCATION hits despite the flag being off', () => {
    const r = classifyAutoMemoryOffCheck({ ...clean, locationHit: true });
    expect(r).toMatchObject({ classification: 'unexpected-hit', conclusive: true });
  });

  it('reads unexpected-hit when ACCESS hits despite the flag being off', () => {
    const r = classifyAutoMemoryOffCheck({ ...clean, accessHit: true });
    expect(r).toMatchObject({ classification: 'unexpected-hit', conclusive: true });
  });

  it('reads unexpected-hit when memoryFiles is non-empty even though neither text observable hit -- the mechanism loaded the file silently, which is a real (partial) hit, not "off"', () => {
    const r = classifyAutoMemoryOffCheck({ ...clean, memoryFilesCount: 1 });
    expect(r).toMatchObject({ classification: 'unexpected-hit', conclusive: true });
    expect(r.note).toContain('memoryFilesCount=1');
  });
});

// ---------------------------------------------------------------------------
// #1681: parseArgs -- flag parsing for --auto-memory-off
// ---------------------------------------------------------------------------

describe('parseArgs -- --auto-memory-off', () => {
  it('defaults autoMemoryOff to false, with the default arm set unaffected (boundary: no args)', () => {
    const parsed = parseArgs([]);
    expect(parsed.autoMemoryOff).toBe(false);
    expect([...parsed.arms].sort()).toEqual(['--a', '--b', '--c', '--d']);
  });

  it('sets autoMemoryOff to true when --auto-memory-off is passed', () => {
    const parsed = parseArgs(['--auto-memory-off']);
    expect(parsed.autoMemoryOff).toBe(true);
  });

  it('tracks --auto-memory-off as its own field, never as a member of arms', () => {
    const parsed = parseArgs(['--auto-memory-off']);
    expect((parsed.arms as Set<string>).has('--auto-memory-off')).toBe(false);
    expect([...parsed.arms].sort()).toEqual(['--a', '--b', '--c', '--d']);
  });
});
