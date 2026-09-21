/**
 * Pins for `scripts/smoke/probe-sdk-session-harness.ts`'s isolation-evidence
 * predicates (Issue #1783).
 *
 * The harness itself needs a real, authenticated `claude` CLI session to
 * exercise end-to-end (it has no `main()`, see its own header), so this file
 * pins only the pure, filesystem-scoped pieces: `snapshotIsolationEvidence`
 * and `verifyIsolationStrict`. Real temp directories, not synthetic
 * in-memory objects -- `snapshotIsolationEvidence()` calls
 * `transcriptFiles()` / `existsSync()` against the filesystem, and the whole
 * point of this gate is that a file a CALLER wrote (`.claude.json`) must not
 * count as evidence, which is only meaningful checked for real.
 *
 * These four cases were originally written directly against
 * `probe-sdk-mcp-settings-sources.ts`'s own local `verifyIsolationStrict`
 * (Architect ruling, PR #1782, CodeRabbit M3) before that logic moved here
 * as the harness's single writer (Issue #1783); this file is where they now
 * live, unchanged in substance.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotIsolationEvidence, verifyIsolationStrict } from '../probe-sdk-session-harness.js';

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'probe-isolation-strict-test-'));
}

describe('verifyIsolationStrict / snapshotIsolationEvidence (Issue #1783)', () => {
  it('the seeded .claude.json alone is NOT evidence -- writing it produces no ok=true delta', () => {
    const configDir = makeConfigDir();
    try {
      const before = snapshotIsolationEvidence(configDir);
      writeFileSync(join(configDir, '.claude.json'), '{}');
      const result = verifyIsolationStrict(configDir, before);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('a grown transcript-file count IS evidence', () => {
    const configDir = makeConfigDir();
    try {
      const before = snapshotIsolationEvidence(configDir);
      mkdirSync(join(configDir, 'projects', 'some-project'), { recursive: true });
      writeFileSync(join(configDir, 'projects', 'some-project', 'abc.jsonl'), '{}\n');
      const result = verifyIsolationStrict(configDir, before);
      expect(result.ok).toBe(true);
      expect(result.after.transcriptCount).toBeGreaterThan(result.before.transcriptCount);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('a newly-created sessions/ dir IS evidence, even with transcript count unchanged', () => {
    const configDir = makeConfigDir();
    try {
      const before = snapshotIsolationEvidence(configDir);
      mkdirSync(join(configDir, 'sessions'), { recursive: true });
      const result = verifyIsolationStrict(configDir, before);
      expect(result.ok).toBe(true);
      expect(result.before.sessionsDirExists).toBe(false);
      expect(result.after.sessionsDirExists).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('an ALREADY-existing sessions/ dir is not re-counted as evidence on a second snapshot (no delta)', () => {
    const configDir = makeConfigDir();
    try {
      mkdirSync(join(configDir, 'sessions'), { recursive: true });
      const before = snapshotIsolationEvidence(configDir);
      const result = verifyIsolationStrict(configDir, before);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // Reach measured, not predicted (Issue #1783 AC item 3). The `before`
  // comparison was temporarily removed from `verifyIsolationStrict` --
  // `ok = after.transcriptCount > before.transcriptCount || (after.sessionsDirExists
  // && !before.sessionsDirExists)` reduced to `ok = after.transcriptCount > 0 ||
  // after.sessionsDirExists` -- and this suite re-run against that mutation.
  // Measured result: 3 pass, 1 fail. Only "an ALREADY-existing sessions/ dir
  // is not re-counted as evidence on a second snapshot (no delta)" failed
  // (expected false, got true); the other three passed unchanged, because a
  // fresh temp dir's `before` snapshot is always {0, false} in every other
  // case here, so presence-only and delta-only agree on them. This is the
  // measured reach: only the no-delta case exercises the `before` comparison
  // at all; the other three exercise `snapshotIsolationEvidence` excluding
  // `.claude.json` and the "growth/appearance is evidence" direction, both of
  // which hold under either implementation. The mutation was reverted
  // immediately after (`git diff` confirmed clean) and the suite re-run
  // green (4 pass, 0 fail) before this comment was written.
});
