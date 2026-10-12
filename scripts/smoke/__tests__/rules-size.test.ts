import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Claude Code warns when a `.claude/rules/*.md` file exceeds 150,000
 * characters, and an unconditionally-loaded rule pays its size on every turn.
 * This net did not exist before `test-trigger.md` grew past the limit.
 *
 * Sizes measured when the per-smoke sections were split out of
 * `test-trigger.md` (chars): `test-trigger.md` 195,869 before and about
 * 19,000 after; `smoke-verification-embedded.md` about 72,000;
 * `smoke-verification-sdk-probes.md` about 67,000;
 * `smoke-verification-server.md` about 44,000. Polarity: the pre-split
 * `test-trigger.md` fails this test at 195,869 chars.
 */
const RULES_DIR = path.resolve(import.meta.dir, '../../../.claude/rules');
const RULE_SIZE_LIMIT_CHARS = 150_000;

describe('.claude/rules/*.md stay under the Claude Code rule-size limit', () => {
  const ruleFiles = readdirSync(RULES_DIR).filter((f) => f.endsWith('.md'));

  it('discovers the rule files (the glob itself is not silently empty)', () => {
    expect(ruleFiles).toContain('test-trigger.md');
    expect(ruleFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of ruleFiles) {
    it(`${file} is under ${RULE_SIZE_LIMIT_CHARS} chars`, () => {
      const content = readFileSync(path.join(RULES_DIR, file), 'utf-8');
      expect(content.length).toBeLessThan(RULE_SIZE_LIMIT_CHARS);
    });
  }
});
