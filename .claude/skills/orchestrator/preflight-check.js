#!/usr/bin/env node

/**
 * Preflight Check — Mechanical pre-merge validation
 *
 * Runs automated checks that don't require human judgment:
 * - Test file coverage for production code changes
 * - Integration test gap detection
 *
 * This is the CI-facing script. For full acceptance checks requiring
 * human judgment (Q1-Q9), use acceptance-check.js via run_process.
 *
 * Local and CI modes produce the same verdict for the same branch state.
 * Both modes use equivalent commands to ensure consistent file lists.
 *
 * Usage:
 *   node .claude/skills/orchestrator/preflight-check.js <PR number>   (CI mode: uses gh pr diff)
 *   node .claude/skills/orchestrator/preflight-check.js              (local mode: uses git diff with same semantic)
 */

import {
  getChangedFiles,
  getLocalChangedFiles,
  categorizeFiles,
  findTestFiles,
  isTestFile,
  detectIntegrationTestNeeds,
  runCommentBlameShiftCheck,
  runLanguageCheck,
} from './check-utils.js';
import { run as runDuplicationCheck } from './rule-skill-duplication-check.js';

// --- Language check display ---

function printLanguageCheck(result) {
  console.log('## Language Check (public artifacts)\n');
  if (result.spawnFailed) {
    console.log(`❌ Could not run language check: ${result.stderr}`);
    console.log('\nThis check requires Bun on PATH. The CI workflow must include the `oven-sh/setup-bun` step before invoking preflight-check.js.');
    return 1;
  }
  if (result.exitCode === 0) {
    console.log('✅ All public artifacts use Latin / Greek / Cyrillic scripts only.');
    return 0;
  }
  const violationLines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  console.log(`❌ Found ${violationLines.length} violation(s) in public artifacts:\n`);
  console.log('```');
  for (const line of violationLines) {
    console.log(line);
  }
  console.log('```');
  console.log('\nRun `bun run check:lang` locally to reproduce. Public artifacts must be in English (see `.claude/rules/workflow.md` Language Policy).');
  return 1;
}

function printCommentBlameShiftCheck(result) {
  console.log('## Source-Comment Blame-Shift Check\n');
  if (result.spawnFailed) {
    console.log(`❌ Could not run source-comment blame-shift check: ${result.stderr}`);
    console.log('\nThis check requires Bun on PATH. The CI workflow must include the `oven-sh/setup-bun` step before invoking preflight-check.js.');
    return 1;
  }
  if (result.exitCode === 0) {
    console.log('✅ No new Issue / PR / dated CodeRabbit references in source comments.');
    return 0;
  }
  // Violation lines come on stdout (one per match). We only consume
  // stdout here; the detector's own summary / remediation lines are
  // appended below from this function (we do not surface stderr).
  const violationLines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  console.log(`❌ Found ${violationLines.length} new violation(s) in source comments:\n`);
  console.log('```');
  for (const line of violationLines) {
    console.log(line);
  }
  console.log('```');
  console.log(
    '\nNew comment references to Issues / PRs / dated CodeRabbit reviews are not allowed — they rot as the codebase evolves. Move the narrative into the PR description / git log instead.',
  );
  return 1;
}

// --- Display ---

function printIntegrationTestCoverage(integrationTestNeeds) {
  if (!integrationTestNeeds) return;

  console.log('### Integration Test Coverage (packages/integration)\n');
  if (integrationTestNeeds.hasIntegrationTestInPr) {
    console.log('- ✅ PR includes integration test changes\n');
  } else {
    console.log('- ⚠ No integration test changes in PR\n');
    console.log('Files triggering integration test review:\n');
    for (const { file, reason } of integrationTestNeeds.triggers) {
      console.log(`- \`${file}\` — ${reason}`);
    }
    if (integrationTestNeeds.isCrossPackage) {
      console.log('\n⚠ Cross-package change (client + server) — integration test strongly recommended');
    }
    console.log();
  }
}

/**
 * Select the coverage-check verdict line. Pure function so the
 * comment-only-exemption wording (Issue #1189) can be unit tested without
 * driving `run()`'s `process.exit()` side effect.
 */
export function formatCoverageVerdict({ hasUnitGaps, gapsCount, hasIntegrationGap, hasCommentOnlyExemptions }) {
  if (hasUnitGaps) return `**${gapsCount} production file(s) missing test coverage.**`;
  if (hasIntegrationGap) return '**Integration test gap detected — review recommended.** ⚠';
  if (hasCommentOnlyExemptions) return '**All test coverage requirements are satisfied (comment-only changes exempted).** ✅';
  return '**All production files have corresponding tests.** ✅';
}

// --- Main ---

function run(changedFiles) {
  const { testCoverage } = findTestFiles(changedFiles);
  const categories = categorizeFiles(changedFiles);
  const integrationTestNeeds = detectIntegrationTestNeeds(changedFiles, categories);

  const filesNeedingCoverage = testCoverage.filter(tc => tc.needsCoverage);
  const commentOnlyExempted = testCoverage.filter(tc => tc.isCommentOnly);
  const hasUnitGaps = filesNeedingCoverage.some(tc => !tc.hasTest);
  const hasIntegrationGap = integrationTestNeeds && !integrationTestNeeds.hasIntegrationTestInPr;

  if (filesNeedingCoverage.length === 0 && commentOnlyExempted.length === 0 && !integrationTestNeeds) {
    console.log('## Test Coverage Check\n');
    console.log('No production files matching coverage patterns were changed.\n');
  } else {
    const gaps = filesNeedingCoverage.filter(tc => !tc.hasTest);
    const covered = filesNeedingCoverage.filter(tc => tc.hasTest);

    console.log('## Test Coverage Check\n');

    if (covered.length > 0) {
      console.log(`### Covered (${covered.length})\n`);
      for (const { file } of covered) {
        console.log(`- ✅ \`${file}\``);
      }
      console.log();
    }

    if (commentOnlyExempted.length > 0) {
      console.log(`### Exempted — comment-only diff (${commentOnlyExempted.length})\n`);
      for (const { file } of commentOnlyExempted) {
        console.log(`- ➖ \`${file}\` — all changed lines are comments/blank`);
      }
      console.log();
    }

    if (gaps.length > 0) {
      console.log(`### Missing Tests (${gaps.length})\n`);
      for (const { file, expectedTestPath, alternateTestPath } of gaps) {
        const alt = alternateTestPath ? ` (or \`${alternateTestPath}\` if JSX-free)` : '';
        console.log(`- ❌ \`${file}\` — expected: \`${expectedTestPath}\`${alt}`);
      }
      console.log();
    }

    printIntegrationTestCoverage(integrationTestNeeds);

    console.log(formatCoverageVerdict({
      hasUnitGaps,
      gapsCount: gaps.length,
      hasIntegrationGap,
      hasCommentOnlyExemptions: commentOnlyExempted.length > 0,
    }));
  }

  // Rule/Skill duplication invariant — runs on every preflight because drift
  // can be introduced by edits anywhere, not just the current PR's diff.
  console.log('\n---\n');
  const duplicationExit = runDuplicationCheck();

  console.log('\n---\n');
  const languageResult = runLanguageCheck();
  const languageExit = printLanguageCheck(languageResult);

  console.log('\n---\n');
  const blameShiftResult = runCommentBlameShiftCheck();
  const blameShiftExit = printCommentBlameShiftCheck(blameShiftResult);

  if (hasUnitGaps || duplicationExit !== 0 || languageExit !== 0 || blameShiftExit !== 0) {
    process.exit(1);
  }
  process.exit(0);
}

// --- Exports for testing ---
export { run };

// --- Entry point ---
const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('preflight-check.js');
if (isMainModule) {
  const prNumber = process.argv[2];
  if (prNumber && !/^\d+$/.test(prNumber)) {
    console.error(`Invalid PR number: ${prNumber}`);
    process.exit(1);
  }
  const changedFiles = prNumber
    ? getChangedFiles(prNumber)
    : getLocalChangedFiles();
  run(changedFiles);
}
