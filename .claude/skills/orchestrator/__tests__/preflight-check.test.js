import { describe, it, expect } from 'bun:test';
import { formatCoverageVerdict } from '../preflight-check.js';

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
