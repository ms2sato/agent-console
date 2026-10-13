import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  formatCoverageVerdict,
  printEmbeddedAgentStdoutWritersCheck,
  printCoverageCheck,
  printWorkspaceLinkCheck,
  printProtocolDispatchCheck,
  printUnreferencedAdditionsCheck,
} from '../preflight-check.js';
import { findTestFiles, PROTOCOL_DISPATCH_TRIGGERS } from '../check-utils.js';

/**
 * Captures every console.log call made during `fn()` and returns the
 * joined output, restoring console.log afterward regardless of outcome.
 */
function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = mock((...args) => {
    lines.push(args.join(' '));
  });
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('formatCoverageVerdict (Issue #1189)', () => {
  it('reports missing coverage when unit gaps exist, regardless of other flags', () => {
    const result = formatCoverageVerdict({
      hasUnitGaps: true,
      gapsCount: 2,
      hasIntegrationGap: true,
      hasCommentOnlyExemptions: true,
    });
    expect(result).toBe('**2 production file(s) missing test coverage.**');
  });

  it('reports an integration test gap when there are no unit gaps', () => {
    const result = formatCoverageVerdict({
      hasUnitGaps: false,
      gapsCount: 0,
      hasIntegrationGap: true,
      hasCommentOnlyExemptions: false,
    });
    expect(result).toBe(
      "**Integration test gap detected — raise it with the requester before opening the PR; this is not the implementer's to waive.** ⚠",
    );
  });

  // The wording is load-bearing, not cosmetic. A delegate who reads the gap as
  // "advisory, so I may decide it myself" is applying the script's exit code as
  // the escalation criterion, which is not the rule's criterion -- see
  // `.claude/rules/workflow.md`, "A joint decision does not unlock a strong
  // preflight recommend". Observed once: the integration gap on a cross-package
  // PR was seen, classified as self-waivable because it left the exit code
  // clean, and never surfaced.
  it('names the escalation obligation rather than merely recommending review', () => {
    const result = formatCoverageVerdict({
      hasUnitGaps: false,
      gapsCount: 0,
      hasIntegrationGap: true,
      hasCommentOnlyExemptions: false,
    });
    expect(result).toContain('raise it with the requester');
    expect(result).not.toContain('review recommended');
  });

  it('does not claim exempted files have corresponding tests — uses exemption-specific wording', () => {
    const result = formatCoverageVerdict({
      hasUnitGaps: false,
      gapsCount: 0,
      hasIntegrationGap: false,
      hasCommentOnlyExemptions: true,
    });
    expect(result).toBe('**All test coverage requirements are satisfied (no-runtime-effect diff (comment-only or type-only import rewiring) exempted).** ✅');
    expect(result).not.toContain('have corresponding tests');
  });

  it('reports the plain all-covered message when there are no gaps and no exemptions', () => {
    const result = formatCoverageVerdict({
      hasUnitGaps: false,
      gapsCount: 0,
      hasIntegrationGap: false,
      hasCommentOnlyExemptions: false,
    });
    expect(result).toBe('**All production files have corresponding tests.** ✅');
  });
});

describe('printCoverageCheck -- excluded-by-rule naming (Issue #1767 follow-up)', () => {
  it('names the excluded interface file and its exclusion rule in the "no production files" branch', () => {
    // Real fixture on disk: an interface-only contract file, excluded by
    // the packages/server/src/repositories/ regex added for Issue #1767.
    // With only this file changed, filesNeedingCoverage and
    // commentOnlyExempted are both empty, so this drives the "No
    // production files..." branch, and the excluded-by-rule addendum must
    // still name the file rather than staying silent.
    const { testCoverage } = findTestFiles(['packages/server/src/repositories/timer-repository.ts']);
    const output = captureConsoleLog(() => {
      printCoverageCheck(testCoverage, null);
    });
    expect(output).toContain('No production files matching coverage patterns were changed.');
    expect(output).toContain('### Exempted -- excluded by rule (1)');
    expect(output).toContain('packages/server/src/repositories/timer-repository.ts');
    expect(output).toContain(
      '^packages\\/server\\/src\\/repositories\\/(?!sqlite-|json-|inbound-)[^/]+-repository\\.ts$',
    );
  });

  it('prints no excluded-by-rule section when the changed file matches no exclusion rule', () => {
    // A hypothetical routes file: matches COVERAGE_PATTERNS, is not
    // excluded, so it lands in the ordinary Missing Tests branch with no
    // excluded-by-rule addendum at all.
    const { testCoverage } = findTestFiles(['packages/server/src/routes/some-new-route.ts']);
    const output = captureConsoleLog(() => {
      printCoverageCheck(testCoverage, null);
    });
    expect(output).not.toContain('Exempted -- excluded by rule');
  });

  it('prints no excluded-by-rule section when there is nothing excluded (byte-identical to before the addendum existed)', () => {
    // A changed test file only: findTestFiles produces an empty
    // testCoverage array, so both the "no production files" line and no
    // excluded-by-rule section should appear.
    const { testCoverage } = findTestFiles(['packages/server/src/repositories/__tests__/timer-repository.test.ts']);
    const output = captureConsoleLog(() => {
      printCoverageCheck(testCoverage, null);
    });
    expect(output).toContain('No production files matching coverage patterns were changed.');
    expect(output).not.toContain('Exempted -- excluded by rule');
  });
});

describe('printCoverageCheck -- no-runtime-effect exemption wording', () => {
  it('names both exempt classes in the heading and in each exempted file line', () => {
    const output = captureConsoleLog(() => {
      printCoverageCheck(
        [
          {
            file: 'packages/server/src/services/foo.ts',
            hasTest: true,
            needsCoverage: false,
            isCommentOnly: true,
            isExcluded: false,
          },
        ],
        null,
      );
    });
    expect(output).toContain('### Exempted — no-runtime-effect diff (comment-only or type-only import rewiring) (1)');
    expect(output).toContain(
      '`packages/server/src/services/foo.ts` — all changed lines are comments, blank, or whole-declaration type-only import/export rewiring',
    );
    expect(output).not.toContain('all changed lines are comments/blank');
  });
});

describe('printEmbeddedAgentStdoutWritersCheck', () => {
  it('renders the success message when exitCode is 0, regardless of stdout content', () => {
    const output = captureConsoleLog(() => {
      printEmbeddedAgentStdoutWritersCheck({ exitCode: 0, stdout: '', stderr: '', spawnFailed: false });
    });
    expect(output).toContain('✅ Only the allowlisted wire-protocol writer writes to stdout');
    expect(output).not.toContain('crashed before producing output');
    expect(output).not.toContain('Found 0 line(s)');
  });

  it('renders the crash-specific message, not the empty-violation-report framing, when exitCode is non-zero with empty stdout', () => {
    const result = {
      exitCode: 1,
      stdout: '',
      stderr: 'TypeError: something exploded',
      spawnFailed: false,
    };
    const output = captureConsoleLog(() => {
      printEmbeddedAgentStdoutWritersCheck(result);
    });
    expect(output).toContain('crashed before producing output (exit 1)');
    expect(output).toContain('TypeError: something exploded');
    expect(output).not.toContain('Found 0 line(s)');
    expect(output).not.toContain('violation(s)');
  });

  it('renders the normal violation-report branch when exitCode is non-zero with non-empty stdout', () => {
    const result = {
      exitCode: 1,
      stdout: 'packages/embedded-agent/src/foo.ts:12:3 console.log(...)',
      stderr: '',
      spawnFailed: false,
    };
    const output = captureConsoleLog(() => {
      printEmbeddedAgentStdoutWritersCheck(result);
    });
    expect(output).toContain('Found 1 line(s) of output, including non-allowlisted stdout-writer violation(s)');
    expect(output).toContain('packages/embedded-agent/src/foo.ts:12:3 console.log(...)');
    expect(output).not.toContain('crashed before producing output');
  });
});

describe('printWorkspaceLinkCheck (Issue #1504)', () => {
  it('prints nothing and returns 0 when nothing is missing', () => {
    const output = captureConsoleLog(() => {
      expect(printWorkspaceLinkCheck([])).toBe(0);
    });
    expect(output).toBe('');
  });

  it('renders the exact stale-install sentence for a single missing dep', () => {
    const output = captureConsoleLog(() => {
      expect(
        printWorkspaceLinkCheck([
          { pkg: 'integration', dep: 'embedded-agent', expectedLink: '/repo/packages/integration/node_modules/@agent-console/embedded-agent' },
        ]),
      ).toBe(1);
    });
    expect(output).toContain(
      "Stale install: integration is missing workspace link(s) embedded-agent -- run 'bun install' in this worktree.",
    );
    expect(output).toContain('Every result below may be a symptom of this, not of your diff.');
  });

  it('groups multiple missing deps for the same package onto one line', () => {
    const output = captureConsoleLog(() => {
      printWorkspaceLinkCheck([
        { pkg: 'client', dep: 'server', expectedLink: '/repo/packages/client/node_modules/@agent-console/server' },
        { pkg: 'client', dep: 'shared', expectedLink: '/repo/packages/client/node_modules/@agent-console/shared' },
      ]);
    });
    expect(output).toContain(
      "Stale install: client is missing workspace link(s) server, shared -- run 'bun install' in this worktree.",
    );
  });

  it('prints one line per affected package when more than one package is missing links', () => {
    const output = captureConsoleLog(() => {
      printWorkspaceLinkCheck([
        { pkg: 'client', dep: 'server', expectedLink: '/repo/packages/client/node_modules/@agent-console/server' },
        { pkg: 'integration', dep: 'embedded-agent', expectedLink: '/repo/packages/integration/node_modules/@agent-console/embedded-agent' },
      ]);
    });
    expect(output).toContain('Stale install: client is missing workspace link(s) server');
    expect(output).toContain('Stale install: integration is missing workspace link(s) embedded-agent');
  });
});

// printProtocolDispatchCheck (Issue #975 Tier 2 / #2044). The returned
// boolean is what `run()` folds into its exit-code OR-chain -- same
// contract as `printCoverageCheck`'s `hasUnitGaps` above, tested the same
// way (literal, synthesized gap-result objects, no process.exit side
// effect; `run()` itself is not driven here because it also spawns the
// duplication/language/blame-shift/embedded-agent-stdout checks against
// the real repo, same boundary as every other test in this file).
//
// The first test's name says "exit 1" / "exit 0" because that is the
// production consequence of this function's return value once wired into
// `run()`'s OR-chain below -- not because this test drives `process.exit`
// itself.
describe('printProtocolDispatchCheck (Issue #975 Tier 2)', () => {
  const TRIGGER_FILE = 'packages/shared/src/types/session.ts';
  const FIXTURE_FILE = PROTOCOL_DISPATCH_TRIGGERS.fixtures[0];

  it('returns true (exit 1) on a synthesized trigger-only diff and names the BLOCKING sentence', () => {
    const output = captureConsoleLog(() => {
      expect(
        printProtocolDispatchCheck({ triggered: [TRIGGER_FILE], fixturesChanged: [], gap: true }),
      ).toBe(true);
    });
    expect(output).toContain('❌ Dispatch-union input(s) changed with NO wire-consumption fixture change');
    expect(output).toContain(TRIGGER_FILE);
    expect(output).toContain('this is BLOCKING');
    expect(output).toContain('Issue #975 Tier 2');
    for (const fixture of PROTOCOL_DISPATCH_TRIGGERS.fixtures) {
      expect(output).toContain(fixture);
    }
  });

  it('returns false (exit 0) when a fixture change lands alongside the trigger', () => {
    const output = captureConsoleLog(() => {
      expect(
        printProtocolDispatchCheck({ triggered: [TRIGGER_FILE], fixturesChanged: [FIXTURE_FILE], gap: false }),
      ).toBe(false);
    });
    expect(output).toContain('✅ Dispatch-union input(s) changed, with a wire-consumption fixture change alongside');
    expect(output).not.toContain('BLOCKING');
  });

  it('returns false (exit 0) when nothing triggers', () => {
    const output = captureConsoleLog(() => {
      expect(printProtocolDispatchCheck({ triggered: [], fixturesChanged: [], gap: false })).toBe(false);
    });
    expect(output).toContain('No protocol dispatch-union inputs changed.');
    expect(output).not.toContain('BLOCKING');
  });

  // Polarity for the wiring itself (not just this function's own verdict):
  // removing `hasProtocolDispatchGap` from `run()`'s exit-code OR-chain
  // makes this test fail, because the source text it pins against would no
  // longer contain the identifier in that `if`. The three tests above
  // cannot catch that regression on their own -- they never call `run()`
  // -- which is exactly why this source-level pin exists alongside them.
  it('is actually wired into run()\'s exit-code OR-chain, not just computed and discarded', () => {
    const sourceCode = readFileSync('.claude/skills/orchestrator/preflight-check.js', 'utf-8');
    const startIdx = sourceCode.indexOf('function run(changedFiles');
    const endIdx = sourceCode.indexOf('\n// --- Exports for testing ---');
    const runSource = sourceCode.slice(startIdx, endIdx);

    expect(runSource).toContain('printProtocolDispatchCheck(protocolDispatchGap)');

    const ifStartIdx = runSource.indexOf('if (\n    hasUnitGaps');
    const ifEndIdx = runSource.indexOf('process.exit(1);', ifStartIdx);
    const exitDecision = runSource.slice(ifStartIdx, ifEndIdx);
    expect(exitDecision).toContain('hasProtocolDispatchGap');
  });
});

describe('printUnreferencedAdditionsCheck', () => {
  it('returns false and prints one clean line when nothing is unreferenced', () => {
    const output = captureConsoleLog(() => {
      expect(printUnreferencedAdditionsCheck({ unreferenced: [] })).toBe(false);
    });
    expect(output).toContain('## Unreferenced additions');
    expect(output).toContain('No added skill script or SKILL.md is left unreferenced.');
    expect(output).not.toContain('❌');
  });

  it('returns true and lists each file, its key and the suggested locations', () => {
    const finding = {
      file: '.claude/skills/orchestrator/zzz-probe.js',
      key: 'zzz-probe.js',
      suggestions: ['.claude/skills/orchestrator/core-responsibilities.md', '.claude/rules/'],
    };
    const output = captureConsoleLog(() => {
      expect(printUnreferencedAdditionsCheck({ unreferenced: [finding] })).toBe(true);
    });
    expect(output).toContain('❌ 1 added file(s) are named by no canonical procedure');
    expect(output).toContain(finding.file);
    expect(output).toContain('key: `zzz-probe.js`');
    for (const suggestion of finding.suggestions) {
      expect(output).toContain(suggestion);
    }
  });

  it('is actually wired into run()\'s exit-code OR-chain, not just computed and discarded', () => {
    const sourceCode = readFileSync('.claude/skills/orchestrator/preflight-check.js', 'utf-8');
    const startIdx = sourceCode.indexOf('function run(changedFiles');
    const endIdx = sourceCode.indexOf('\n// --- Exports for testing ---');
    const runSource = sourceCode.slice(startIdx, endIdx);

    expect(runSource).toContain('checkUnreferencedAdditions(addedFiles, repoRoot)');
    const ifStartIdx = runSource.indexOf('if (\n    hasUnitGaps');
    const ifEndIdx = runSource.indexOf('process.exit(1);', ifStartIdx);
    expect(runSource.slice(ifStartIdx, ifEndIdx)).toContain('hasUnreferencedAddition');
  });
});
