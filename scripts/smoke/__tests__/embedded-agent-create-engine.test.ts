import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Registry-style pin for Issue #1792: PR #1780 made
 * `CreateEmbeddedAgentRequestSchema` an `engine`-discriminated `v.variant`
 * (`packages/shared/src/schemas/embedded-agent.ts`), so a
 * `POST /api/embedded-agents` body missing `engine` now gets a 500
 * (`ValidationError: engine: Invalid type...`) instead of the 201 every
 * smoke fixture-creation call expects. Three smoke scripts hit exactly
 * this -- `check-embedded-agent-elevation.ts`, `check-embedded-agent-bash-
 * env.ts`, `check-webhook-issue-label-routing.ts` -- surfaced only when
 * PR #1789's tier-3 run reached step 9 weeks after #1780 landed, because
 * the tier-3 workflow is paths-filtered and #1780 touched none of its
 * paths.
 *
 * This pin closes that gap mechanically: any `scripts/smoke/*` file that
 * both names the create route and builds a `JSON.stringify({` request body
 * must also carry `engine: '` somewhere in its text -- so the NEXT time
 * this schema (or a sibling one shaped like it) tightens, the smoke that
 * calls it fails in the ordinary test suite, not in a tier-3 run weeks
 * later.
 *
 * Glob-driven (not a hardcoded file list), same convention as the sibling
 * `registry-reachability.test.ts`: a future smoke that creates an
 * embedded-agent definition is covered automatically.
 *
 * Polarity (measured against this PR's own fix, per the Issue's AC):
 * removing the `engine: 'openai-api',` line from
 * `check-embedded-agent-elevation.ts`'s create body reproduces the exact
 * pre-fix shape and flips this test's corresponding assertion from pass to
 * fail -- confirmed by temporarily deleting that one line, observing the
 * failure, then restoring it.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_DIR = path.join(REPO_ROOT, 'scripts/smoke');

const CREATE_ROUTE_PATTERN = /\/api\/embedded-agents/;
const CREATE_BODY_PATTERN = /JSON\.stringify\(\{/;
const ENGINE_FIELD_PATTERN = /engine:\s*'/;

function discoverSmokeFiles(): string[] {
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: SMOKE_DIR, onlyFiles: true })].sort();
}

describe('scripts/smoke/* embedded-agent create calls carry `engine` (Issue #1792)', () => {
  const smokeFiles = discoverSmokeFiles();

  it('discovers a non-trivial number of smoke scripts (the discovery glob itself is not silently empty)', () => {
    expect(smokeFiles.length).toBeGreaterThanOrEqual(20);
  });

  const candidates = smokeFiles.filter((file) => {
    const content = readFileSync(path.join(SMOKE_DIR, file), 'utf-8');
    return CREATE_ROUTE_PATTERN.test(content) && CREATE_BODY_PATTERN.test(content);
  });

  it('finds at least the three smoke scripts known to create an embedded-agent definition (the filter itself is not silently empty)', () => {
    // Same "empty discovery masks every assertion below" shape as
    // registry-reachability.test.ts's own guards -- workflow.md
    // sub-pattern 9. Floor of 3, matching this Issue's own enumeration.
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates).toContain('check-embedded-agent-elevation.ts');
    expect(candidates).toContain('check-embedded-agent-bash-env.ts');
    expect(candidates).toContain('check-webhook-issue-label-routing.ts');
  });

  for (const file of candidates) {
    it(`${file}: a script naming the create route and building a JSON.stringify({ body also carries \`engine: '\``, () => {
      const content = readFileSync(path.join(SMOKE_DIR, file), 'utf-8');
      expect(ENGINE_FIELD_PATTERN.test(content)).toBe(true);
    });
  }
});
