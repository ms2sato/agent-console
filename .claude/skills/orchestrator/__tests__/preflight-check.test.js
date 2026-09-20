import { describe, it, expect, mock } from 'bun:test';
import { formatCoverageVerdict, printEmbeddedAgentStdoutWritersCheck, printCoverageCheck } from '../preflight-check.js';
import { findTestFiles } from '../check-utils.js';

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
    expect(result).toBe('**All test coverage requirements are satisfied (comment-only changes exempted).** ✅');
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
