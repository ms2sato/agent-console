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

// --- Main ---

function run(changedFiles) {
  const { testCoverage } = findTestFiles(changedFiles);
  const categories = categorizeFiles(changedFiles);
  const integrationTestNeeds = detectIntegrationTestNeeds(changedFiles, categories);

  const filesNeedingCoverage = testCoverage.filter(tc => tc.needsCoverage);
  const hasUnitGaps = filesNeedingCoverage.some(tc => !tc.hasTest);
  const hasIntegrationGap = integrationTestNeeds && !integrationTestNeeds.hasIntegrationTestInPr;

  if (filesNeedingCoverage.length === 0 && !integrationTestNeeds) {
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

    if (gaps.length > 0) {
      console.log(`### Missing Tests (${gaps.length})\n`);
      for (const { file, expectedTestPath } of gaps) {
        console.log(`- ❌ \`${file}\` — expected: \`${expectedTestPath}\``);
      }
      console.log();
    }

    printIntegrationTestCoverage(integrationTestNeeds);

    if (hasUnitGaps) {
      console.log(`**${gaps.length} production file(s) missing test coverage.**`);
    } else if (hasIntegrationGap) {
      console.log('**Integration test gap detected — review recommended.** ⚠');
    } else {
      console.log('**All production files have corresponding tests.** ✅');
    }
  }

  // Rule/Skill duplication invariant — runs on every preflight because drift
  // can be introduced by edits anywhere, not just the current PR's diff.
  console.log('\n---\n');
  const duplicationExit = runDuplicationCheck();

  console.log('\n---\n');
  const languageResult = runLanguageCheck();
  const languageExit = printLanguageCheck(languageResult);

  if (hasUnitGaps || duplicationExit !== 0 || languageExit !== 0) {
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
