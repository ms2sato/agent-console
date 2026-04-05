#!/usr/bin/env node

/**
 * Preflight Check — Mechanical pre-merge validation
 *
 * Runs automated checks that don't require human judgment:
 * - Test file coverage for production code changes
 * - Integration test gap detection
 *
 * This is the CI-facing script. For full acceptance checks requiring
 * human judgment (Q1-Q7), use acceptance-check.js via run_process.
 *
 * Usage:
 *   node .claude/skills/orchestrator/preflight-check.js <PR number>
 *   node .claude/skills/orchestrator/preflight-check.js              (uses local git diff against main)
 */

import {
  getChangedFiles,
  getLocalChangedFiles,
  categorizeFiles,
  findTestFiles,
  isTestFile,
  detectIntegrationTestNeeds,
} from './check-utils.js';

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
    process.exit(0);
  }

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
    process.exit(1);
  } else if (hasIntegrationGap) {
    console.log('**Integration test gap detected — review recommended.** ⚠');
    process.exit(0);
  } else {
    console.log('**All production files have corresponding tests.** ✅');
    process.exit(0);
  }
}

// --- Exports for testing ---
export { run };

// --- Entry point ---
const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('preflight-check.js');
if (isMainModule) {
  const prNumber = process.argv[2];
  const changedFiles = (prNumber && /^\d+$/.test(prNumber))
    ? getChangedFiles(prNumber)
    : getLocalChangedFiles();
  run(changedFiles);
}
