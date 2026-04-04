#!/usr/bin/env node

/**
 * Orchestrator Acceptance Check Support Script (Wizard Mode)
 *
 * Automatically analyzes PR changes and guides the Orchestrator through Q1-Q7
 * in a step-by-step wizard. State is persisted to a JSON file
 * so answers carry over across invocations.
 *
 * Features:
 * - File categorization by package (client/server/shared/test)
 * - Test file detection and coverage analysis
 * - Issue acceptance criteria parsing
 * - Package boundary analysis
 *
 * Usage:
 *   node .claude/skills/orchestrator/acceptance-check.js <PR number>
 *   node .claude/skills/orchestrator/acceptance-check.js <PR number> q1 "answer"
 *   node .claude/skills/orchestrator/acceptance-check.js <PR number> --check-only
 *   node .claude/skills/orchestrator/acceptance-check.js --check-only  (uses local git diff against main)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

// --- Utility functions ---

function usage() {
  console.error('Usage:');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js <PR number>');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js <PR number> q1 "answer"');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js <PR number> --check-only');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js --check-only');
  console.error('Example:');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js 42');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js 42 q1 "Read worker-service.ts..."');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js 42 --check-only');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js --check-only  # uses local git diff');
  process.exit(1);
}

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getChangedFiles(prNumber) {
  const result = exec(`gh pr diff ${prNumber} --name-only`);
  if (result === null) {
    console.error(`Error: Could not retrieve diff for PR #${prNumber}. Please verify the gh command and PR number.`);
    process.exit(1);
  }
  return result.split('\n').filter(Boolean);
}

function getLocalChangedFiles() {
  const baseBranch = process.env.BASE_BRANCH || 'origin/main';
  const mergeBase = exec(`git merge-base ${baseBranch} HEAD`);
  if (!mergeBase) {
    console.error(`Error: Could not determine merge-base with ${baseBranch}. Ensure git is available and the branch exists.`);
    process.exit(1);
  }
  const result = exec(`git diff --name-only ${mergeBase}...HEAD`);
  if (result === null) {
    console.error('Error: Could not retrieve local git diff.');
    process.exit(1);
  }
  return result.split('\n').filter(Boolean);
}

// --- File categorization ---

function categorizeFile(filePath) {
  if (filePath.startsWith('packages/integration/')) {
    return 'integration';
  }
  if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/')) {
    return 'test';
  }
  if (filePath.startsWith('packages/client/')) {
    return 'client';
  }
  if (filePath.startsWith('packages/server/')) {
    return 'server';
  }
  if (filePath.startsWith('packages/shared/')) {
    return 'shared';
  }
  return 'other';
}

function categorizeFiles(files) {
  const categories = { client: [], server: [], shared: [], integration: [], test: [], other: [] };
  for (const file of files) {
    const category = categorizeFile(file);
    categories[category].push(file);
  }
  return categories;
}

// --- Test file detection ---

// Patterns that require test coverage (production code only)
const COVERAGE_PATTERNS = [
  /^packages\/server\/src\/routes\/.+\.ts$/,
  /^packages\/server\/src\/services\/.+\.ts$/,
  /^packages\/client\/src\/hooks\/.+\.ts$/,
  /^packages\/client\/src\/components\/.+\.tsx$/,
  /^packages\/shared\/src\/.+\.ts$/,
];

function isTestFile(filePath) {
  return filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/');
}

function requiresTestCoverage(filePath) {
  if (isTestFile(filePath)) return false;
  return COVERAGE_PATTERNS.some(pattern => pattern.test(filePath));
}

function findTestFiles(changedFiles) {
  const testFiles = [];
  const productionFiles = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      testFiles.push(file);
    } else if (file.match(/\.(ts|tsx|js|jsx)$/)) {
      productionFiles.push(file);
    }
  }

  // For each production file, check if a matching test exists in the PR
  // Supports multiple naming conventions: __tests__/Name.test.ts, __tests__/Name.test.tsx,
  // Name.test.ts (sibling), etc.
  const testCoverage = [];
  for (const prodFile of productionFiles) {
    const ext = prodFile.match(/\.(ts|tsx|js|jsx)$/)[0];
    const baseName = prodFile.replace(/\.(ts|tsx|js|jsx)$/, '');
    const dir = baseName.substring(0, baseName.lastIndexOf('/'));
    const fileName = baseName.substring(baseName.lastIndexOf('/') + 1);

    // Check multiple possible test file patterns using full path matching
    // to avoid false positives from basename collisions (e.g., routes/index.ts vs services/index.ts)
    const testPattern = new RegExp(`\\.(test|spec)\\.(ts|tsx|js|jsx)$`);
    const hasTest = testFiles.some(tf => {
      if (!testPattern.test(tf)) return false;
      const tfDir = tf.substring(0, tf.lastIndexOf('/'));
      const tfFileName = tf.substring(tf.lastIndexOf('/') + 1);
      const tfBaseName = tfFileName.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '');
      if (tfBaseName !== fileName) return false;
      // Match: sibling test (same dir) or __tests__ subdirectory
      return tfDir === dir || tfDir === dir + '/__tests__';
    });

    const needsCoverage = requiresTestCoverage(prodFile);
    const expectedTestPath = dir + '/__tests__/' + fileName + '.test' + (ext === '.tsx' ? '.tsx' : '.ts');
    testCoverage.push({ file: prodFile, hasTest, expectedTestPath, needsCoverage });
  }

  return { testFiles, productionFiles, testCoverage };
}

// --- Integration test detection ---

// Patterns that suggest integration test coverage is needed:
// - Client components (may involve state transitions, forms, multi-phase UI)
// - Server routes (API endpoints that clients consume)
// - Shared types (cross-package contracts)
const INTEGRATION_TRIGGER_PATTERNS = [
  { pattern: /^packages\/client\/src\/components\/.+\.tsx$/, reason: 'UI component (may involve state transitions or forms)' },
  { pattern: /^packages\/server\/src\/routes\/.+\.ts$/, reason: 'API route (client-server contract)' },
  { pattern: /^packages\/shared\/src\/.+\.ts$/, reason: 'shared type (cross-package contract)' },
];

function getIntegrationTestDir() {
  return 'packages/integration/src';
}

function listExistingIntegrationTests() {
  const dir = getIntegrationTestDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .map(f => dir + '/' + f);
  } catch {
    return [];
  }
}

function detectIntegrationTestNeeds(changedFiles, categories) {
  const triggers = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) continue;
    for (const { pattern, reason } of INTEGRATION_TRIGGER_PATTERNS) {
      if (pattern.test(file)) {
        triggers.push({ file, reason });
        break;
      }
    }
  }

  if (triggers.length === 0) return null;

  // Check if the PR includes integration test changes
  const hasIntegrationTestInPr = changedFiles.some(
    f => f.startsWith('packages/integration/') && isTestFile(f)
  );

  // Check cross-package indicator (stronger signal)
  const isCrossPackage = categories.client.length > 0 && categories.server.length > 0;
  const hasSharedChanges = categories.shared.length > 0;

  return {
    triggers,
    hasIntegrationTestInPr,
    isCrossPackage,
    hasSharedChanges,
    existingIntegrationTests: listExistingIntegrationTests(),
  };
}

// --- Package boundary analysis ---

function analyzePackageBoundaries(categories) {
  const boundaries = [];

  if (categories.shared.length > 0) {
    boundaries.push({
      type: 'shared-type-change',
      message: 'Shared types/utilities changed — verify both client and server consumers are updated',
      files: categories.shared,
    });
  }

  if (categories.client.length > 0 && categories.server.length > 0) {
    boundaries.push({
      type: 'cross-package',
      message: 'Changes span client and server — verify WebSocket/REST API contracts are consistent',
      files: [...categories.client, ...categories.server],
    });
  }

  if (categories.server.some((f) => f.includes('websocket') || f.includes('ws'))) {
    boundaries.push({
      type: 'websocket-change',
      message: 'WebSocket handler changed — verify protocol compatibility with client',
      files: categories.server.filter((f) => f.includes('websocket') || f.includes('ws')),
    });
  }

  return boundaries;
}

// --- Issue and acceptance criteria ---

function getLinkedIssueNumber(prNumber) {
  const result = exec(`gh pr view ${prNumber} --json body --jq .body`);
  if (!result) return null;

  // Match: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
  const match = result.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match ? match[1] : null;
}

function getIssueInfo(issueNumber) {
  const title = exec(`gh issue view ${issueNumber} --json title --jq .title`);
  const body = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  return { title: title || '', body: body || '' };
}

function getAcceptanceCriteria(issueNumber) {
  const result = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  if (!result) return [];

  const lines = result.split('\n');
  const criteria = [];

  for (const line of lines) {
    const match = line.match(/^- \[ \]\s+(.+)/);
    if (match) {
      criteria.push(match[1].trim());
    }
  }

  return criteria;
}

// --- State management ---

function getStateFilePath(prNumber) {
  return `.acceptance-check-${prNumber}.json`;
}

function loadState(prNumber) {
  const path = getStateFilePath(prNumber);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveState(state) {
  const path = getStateFilePath(state.prNumber);
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// --- CI status check ---

function getCiStatus(prNumber) {
  const result = exec(`gh pr checks ${prNumber} --json name,state,conclusion 2>/dev/null`);
  if (!result) return null;
  try {
    const checks = JSON.parse(result);
    const failed = checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'failure');
    const pending = checks.filter(c => c.state === 'PENDING' || c.state === 'pending' || c.state === 'IN_PROGRESS');
    const passed = checks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success');
    return { checks, failed, pending, passed, allGreen: failed.length === 0 && pending.length === 0 };
  } catch {
    return null;
  }
}

// --- Auto-detection ---

function runAutoDetection(prNumber) {
  const changedFiles = getChangedFiles(prNumber);
  const categories = categorizeFiles(changedFiles);
  const { testFiles, productionFiles, testCoverage } = findTestFiles(changedFiles);
  const boundaries = analyzePackageBoundaries(categories);
  const ciStatus = getCiStatus(prNumber);

  const linkedIssue = getLinkedIssueNumber(prNumber);
  let acceptanceCriteria = [];
  if (linkedIssue) {
    acceptanceCriteria = getAcceptanceCriteria(linkedIssue);
  }

  const integrationTestNeeds = detectIntegrationTestNeeds(changedFiles, categories);

  return {
    changedFiles,
    categories,
    testFiles,
    productionFiles,
    testCoverage,
    boundaries,
    linkedIssue,
    acceptanceCriteria,
    ciStatus,
    integrationTestNeeds,
  };
}

// --- Display functions ---

function printIntegrationTestCoverage(integrationTestNeeds) {
  console.log('[Integration Test Coverage (packages/integration)]');
  if (!integrationTestNeeds) {
    console.log('  No files triggering integration test check.');
    console.log();
    return;
  }

  const { triggers, hasIntegrationTestInPr, isCrossPackage, hasSharedChanges, existingIntegrationTests } = integrationTestNeeds;

  console.log(`  Files triggering integration test review (${triggers.length}):`);
  for (const { file, reason } of triggers) {
    console.log(`    - ${file} (${reason})`);
  }

  if (isCrossPackage) {
    console.log('  ⚠ Cross-package change detected (client + server) — integration test strongly recommended');
  }
  if (hasSharedChanges) {
    console.log('  ⚠ Shared type changes detected — verify integration test covers the contract');
  }

  if (hasIntegrationTestInPr) {
    console.log('  ✅ PR includes changes in packages/integration/');
  } else {
    console.log('  ❌ PR does NOT include integration test changes in packages/integration/');
    console.log('     Consider adding an integration test for cross-component or state-transition behavior.');
  }

  if (existingIntegrationTests.length > 0) {
    console.log(`  Existing integration tests (${existingIntegrationTests.length}):`);
    for (const t of existingIntegrationTests) {
      console.log(`    - ${t}`);
    }
  }
  console.log();
}

function printAutoDetection(autoDetection) {
  const { categories, testFiles, testCoverage, boundaries, linkedIssue, acceptanceCriteria, ciStatus, integrationTestNeeds } = autoDetection;

  // CI status (must be green before acceptance)
  console.log('[CI Status]');
  if (!ciStatus) {
    console.log('  ⚠ Could not retrieve CI status');
  } else if (ciStatus.allGreen) {
    console.log(`  ✅ All checks passed (${ciStatus.passed.length} checks)`);
  } else {
    if (ciStatus.failed.length > 0) {
      console.log(`  ❌ FAILED checks (${ciStatus.failed.length}):`);
      for (const c of ciStatus.failed) {
        console.log(`    - ${c.name}`);
      }
      console.log('  ⛔ CI must be green before acceptance. Do NOT proceed until all checks pass.');
    }
    if (ciStatus.pending.length > 0) {
      console.log(`  ⏳ Pending checks (${ciStatus.pending.length}):`);
      for (const c of ciStatus.pending) {
        console.log(`    - ${c.name}`);
      }
      console.log('  ⏳ Wait for all checks to complete before proceeding.');
    }
  }
  console.log();

  // File categorization
  console.log('[File Categorization]');
  for (const [category, files] of Object.entries(categories)) {
    if (files.length > 0) {
      console.log(`  ${category} (${files.length}):`);
      for (const f of files) {
        console.log(`    - ${f}`);
      }
    }
  }
  console.log();

  // Test coverage
  console.log('[Test Coverage]');
  if (testFiles.length === 0) {
    console.log('  No test files in PR');
  } else {
    console.log(`  Test files (${testFiles.length}):`);
    for (const f of testFiles) {
      console.log(`    - ${f}`);
    }
  }
  console.log();

  console.log('[Production File Test Coverage]');
  if (testCoverage.length === 0) {
    console.log('  (no production code files)');
  } else {
    for (const { file, hasTest, expectedTestPath, needsCoverage } of testCoverage) {
      if (hasTest) {
        console.log(`  ✅ ${file} -> covered`);
      } else if (needsCoverage) {
        console.log(`  ❌ ${file} -> NO TEST (expected: ${expectedTestPath})`);
      } else {
        console.log(`  ⬜ ${file} -> skipped (not in coverage patterns)`);
      }
    }
  }
  console.log();

  // Integration test coverage
  printIntegrationTestCoverage(integrationTestNeeds);

  // Package boundary analysis
  if (boundaries.length > 0) {
    console.log('[Package Boundary Alerts]');
    for (const b of boundaries) {
      console.log(`  [${b.type}] ${b.message}`);
      for (const f of b.files) {
        console.log(`    - ${f}`);
      }
    }
    console.log();
  }

  // Acceptance criteria
  if (linkedIssue) {
    if (acceptanceCriteria.length > 0) {
      console.log(`[Issue #${linkedIssue} Acceptance Criteria -> Test Coverage Check]`);
      console.log();
      console.log('For each criterion below, confirm the corresponding test file and test case name.');
      console.log('If any are blank, tests may be insufficient.');
      console.log();
      for (let i = 0; i < acceptanceCriteria.length; i++) {
        console.log(`Criterion ${i + 1}: ${acceptanceCriteria[i]}`);
        console.log('  -> Corresponding test: (Orchestrator to verify)');
        console.log();
      }
    } else {
      console.log(`[Issue #${linkedIssue}] No acceptance criteria (checklist) found.`);
      console.log();
    }
  } else {
    console.log('[No linked Issue] No "closed #NNN" pattern found in PR body.');
    console.log();
  }

  // Integration test adequacy prompt
  printIntegrationTestAdequacy(linkedIssue);
}

function printIntegrationTestAdequacy(linkedIssue) {
  console.log('--- Integration Test Adequacy ---');
  console.log('Before answering, re-read the linked Issue and consider:');
  console.log('  1. What is the user-facing purpose of this change?');
  console.log('  2. What user operations does it affect?');
  console.log('  3. For each operation, is there an integration test that verifies');
  console.log('     the full path (input → processing → output/side-effect)?');
  console.log('  4. Are there scenarios where only unit tests exist but the user-facing');
  console.log('     behavior is not verified end-to-end?');
  console.log();

  if (linkedIssue) {
    const issueInfo = getIssueInfo(linkedIssue);
    console.log(`Linked Issue: #${linkedIssue} — ${issueInfo.title}`);
    if (issueInfo.body) {
      const bodyPreview = issueInfo.body.length > 500 ? issueInfo.body.substring(0, 500) + '...' : issueInfo.body;
      console.log(bodyPreview);
    }
  } else {
    console.log('No linked Issue found — evaluate integration test adequacy based on the PR description.');
  }
  console.log();
}

function getQuestions(hasAcceptanceCriteria) {
  return [
    {
      key: 'q1',
      text: 'Q1: Domain Design — Is the service layer properly separated? Is there business logic leaking into route handlers or MCP tools?',
      focus: 'Check that domain logic lives in service classes/functions, not in Hono route handlers or MCP tool definitions. Handlers should only parse input, call services, and format output.',
      insufficient: '"Looks good" (no evidence)',
      sufficient: '"Read worker-service.ts L20-45 in gh pr diff. Worker creation logic (validation, PTY spawn, state init) is in WorkerService.create(). The route handler in worker-routes.ts L15 only parses the request body, calls service.create(), and returns the result. No business logic in the handler."',
    },
    {
      key: 'q2',
      text: 'Q2: Cross-Boundary Tests — Are WebSocket/REST/shared type contracts tested across package boundaries?',
      focus: 'If the PR changes cross-package interfaces (shared types, WebSocket messages, REST endpoints), verify that integration tests exist to confirm both sides agree on the contract.',
      insufficient: '"Tests exist" (without identifying specific cross-boundary test cases)',
      sufficient: '"PR changes WorkerStateMessage in packages/shared. Found integration test in server/tests/worker-ws.test.ts L30 that sends a state update via WebSocket and verifies the client receives the correct shape. Also verified the client-side handler in client/src/hooks/useWorkerWs.ts matches the type."',
    },
    {
      key: 'q3',
      text: hasAcceptanceCriteria
        ? 'Q3: Acceptance Criteria — For each criterion in the "Acceptance Criteria -> Test Coverage Check" above, have you identified the corresponding test? Are there any criteria without a corresponding test?'
        : 'Q3: Domain Invariants — List the domain invariants. Is each invariant verified by a test?',
      focus: 'Map each acceptance criterion 1-to-1 to a specific test file name and test case name. Any criterion without a corresponding test indicates insufficient testing.',
      insufficient: '"All criteria have tests" (without naming specific tests)',
      sufficient: '"Criterion 1: Worker state transitions validated -> verified by worker-service.test.ts L25 \'rejects invalid state transition\'. Criterion 2: Session cleanup removes workers -> verified by session-service.test.ts L80 \'cleanup removes all associated workers\'. Criterion 3: no corresponding test found -> instructed agent to add."',
    },
    {
      key: 'q4',
      text: 'Q4: Pattern Consistency — Are the changes consistent with existing codebase patterns? If there is a design change (e.g., error handling approach, type structure), are there remnants of the old pattern?',
      focus: 'If there is a design change, grep for old pattern occurrences and verify there are no missed changes. Also check if the new code follows established conventions.',
      insufficient: '"No remnants" (did not search)',
      sufficient: '"PR changes error handling from throw to Result type. Searched grep \'throw new AppError\' packages/server/src/ and found zero remaining instances. New pattern is consistent with Result<T, E> usage in existing services like session-service.ts L12."',
    },
    {
      key: 'q5',
      text: 'Q5: Shared Type / Interface Side Effects — Do changes to shared types or interfaces affect other consumers? Are all consumers updated?',
      focus: 'If shared types are modified, grep for all import sites and verify each consumer handles the change correctly.',
      insufficient: '"No side effects" (did not search for consumers)',
      sufficient: '"PR adds optional field \'metadata\' to WorkerConfig in packages/shared. Searched grep \'WorkerConfig\' across all packages — found 3 consumers: worker-service.ts (handles metadata in create()), useWorkerConfig.ts (passes metadata through), WorkerPanel.tsx (displays metadata if present). All handle the optional field correctly."',
    },
    {
      key: 'q6',
      text: 'Q6: PR Scope — Is the PR focused on a single concern? Are there unrelated changes mixed in?',
      focus: 'Review the file list and diffs for changes that do not relate to the stated PR purpose. Formatting-only changes, unrelated refactors, or scope creep should be flagged.',
      insufficient: '"PR is focused" (without reviewing the file list)',
      sufficient: '"PR title says \'Add worker restart\'. All 6 changed files relate to worker lifecycle: worker-service.ts (restart logic), worker-routes.ts (endpoint), worker-service.test.ts (tests), WorkerPanel.tsx (restart button), useWorkerActions.ts (hook), shared/types.ts (RestartWorkerMessage). No unrelated changes."',
    },
    {
      key: 'q7',
      text: 'Q7: Error Handling — Are failure scenarios handled? (WebSocket disconnect, PTY process death, invalid input, concurrent operations)',
      focus: 'Check that the PR handles relevant failure modes for the domain. Not every PR needs all categories — focus on what is relevant to the change.',
      insufficient: '"Error handling is fine" (no specifics)',
      sufficient: '"PR adds worker restart. Checked: (1) PTY death during restart — worker-service.ts L60 catches spawn failure and transitions to \'error\' state. (2) Invalid worker ID — route handler returns 404 via service Result. (3) Concurrent restart — service checks current state and rejects if already restarting. WebSocket disconnect is not relevant to this change."',
    },
  ];
}

function printQuestion(question) {
  console.log(`--- ${question.key.toUpperCase()} ---`);
  console.log(question.text);
  console.log(`  Focus: ${question.focus}`);
  if (question.insufficient) {
    console.log(`  Insufficient answer: ${question.insufficient}`);
  }
  if (question.sufficient) {
    console.log(`  Sufficient answer: ${question.sufficient}`);
  }
  console.log();
}

function printAnswerCommand(prNumber, questionKey) {
  console.log(`Answer: node .claude/skills/orchestrator/acceptance-check.js ${prNumber} ${questionKey} "your answer here"`);
  console.log();
}

function printSummary(state) {
  const questions = getQuestions(state.autoDetection.acceptanceCriteria.length > 0);

  console.log('=== Answer Summary ===');
  for (const q of questions) {
    const answer = state.answers[q.key];
    if (answer) {
      const display = answer.length > 100 ? answer.substring(0, 100) + '...' : answer;
      console.log(`${q.key.toUpperCase()}: OK ${display}`);
    } else {
      console.log(`${q.key.toUpperCase()}: -- Not answered`);
    }
  }
  console.log();
}

function printPostAcceptanceWorkflow() {
  console.log('--- Post-Acceptance Workflow ---');
  console.log('After acceptance PASS:');
  console.log('1. Report review request to the owner (update memo)');
  console.log('2. WARNING: Do NOT delete the worktree until the PR is merged');
  console.log('3. After merge: conflict check -> worktree cleanup -> update memo');
  console.log();
}

// --- Check-only mode ---

function runCheckOnly(changedFiles) {
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

  // Integration test coverage section
  if (integrationTestNeeds) {
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

  if (hasUnitGaps) {
    console.log(`**${gaps.length} production file(s) missing test coverage.**`);
    process.exit(1);
  } else if (hasIntegrationGap) {
    console.log('**Integration test gap detected — review recommended.** ⚠');
    process.exit(1);
  } else {
    console.log('**All production files have corresponding tests.** ✅');
    process.exit(0);
  }
}

// --- Exports for testing ---
export {
  categorizeFile,
  categorizeFiles,
  isTestFile,
  requiresTestCoverage,
  findTestFiles,
  detectIntegrationTestNeeds,
  listExistingIntegrationTests,
  INTEGRATION_TRIGGER_PATTERNS,
};

// --- Main ---

// Guard: skip main execution when imported as a module for testing
const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('acceptance-check.js');
if (!isMainModule) {
  // Module is being imported for testing — do not execute main logic
} else {

const isCheckOnly = process.argv.includes('--check-only');

const prNumber = process.argv[2];

// --check-only can run without a PR number (uses local git diff)
if (isCheckOnly) {
  const changedFiles = (prNumber && /^\d+$/.test(prNumber))
    ? getChangedFiles(prNumber)
    : getLocalChangedFiles();
  runCheckOnly(changedFiles);
}

if (!prNumber || !/^\d+$/.test(prNumber)) {
  usage();
}

const questionArg = process.argv[3];
const answerArg = process.argv[4];

const VALID_QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
if (questionArg && !VALID_QUESTIONS.includes(questionArg.toLowerCase())) {
  console.error(`Error: Invalid question key "${questionArg}". Must be one of: ${VALID_QUESTIONS.join(', ')}`);
  process.exit(1);
}

if (questionArg && !answerArg) {
  console.error(`Error: Answer is required when specifying a question key.`);
  console.error(`Usage: node .claude/skills/orchestrator/acceptance-check.js ${prNumber} ${questionArg} "your answer here"`);
  process.exit(1);
}

// Load or create state
let state = loadState(prNumber);

if (!state) {
  // First run: perform auto-detection
  console.log(`=== PR #${prNumber} Acceptance Check ===\n`);
  const autoDetection = runAutoDetection(prNumber);

  state = {
    prNumber,
    startedAt: new Date().toISOString(),
    autoDetection,
    answers: {
      q1: null,
      q2: null,
      q3: null,
      q4: null,
      q5: null,
      q6: null,
      q7: null,
    },
  };
  saveState(state);

  // Print auto-detection results
  printAutoDetection(autoDetection);

  // Show Q1
  const questions = getQuestions(autoDetection.acceptanceCriteria.length > 0);
  printQuestion(questions[0]);
  printAnswerCommand(prNumber, 'q1');
} else if (questionArg) {
  // Answer a specific question
  const qKey = questionArg.toLowerCase();
  const qIndex = VALID_QUESTIONS.indexOf(qKey);

  console.log(`=== PR #${prNumber} Acceptance Check ===\n`);

  // Save the answer
  state.answers[qKey] = answerArg;
  saveState(state);

  console.log(`OK ${qKey.toUpperCase()} answered`);
  console.log();

  const hasAcceptanceCriteria = state.autoDetection.acceptanceCriteria.length > 0;
  const questions = getQuestions(hasAcceptanceCriteria);

  if (qIndex < VALID_QUESTIONS.length - 1) {
    // Show next question
    const nextQuestion = questions[qIndex + 1];
    printQuestion(nextQuestion);
    printAnswerCommand(prNumber, nextQuestion.key);
  } else {
    // Last question answered: show summary + post-acceptance workflow
    printSummary(state);
    printPostAcceptanceWorkflow();
  }
} else {
  // Re-run without question arg: show auto-detection + current progress + next unanswered question
  console.log(`=== PR #${prNumber} Acceptance Check (resumed) ===\n`);
  printAutoDetection(state.autoDetection);

  const hasAcceptanceCriteria = state.autoDetection.acceptanceCriteria.length > 0;
  const questions = getQuestions(hasAcceptanceCriteria);

  // Show answered questions summary
  let allAnswered = true;
  let nextUnanswered = null;
  for (const q of questions) {
    if (state.answers[q.key]) {
      console.log(`OK ${q.key.toUpperCase()}: ${state.answers[q.key].length > 80 ? state.answers[q.key].substring(0, 80) + '...' : state.answers[q.key]}`);
    } else {
      if (!nextUnanswered) {
        nextUnanswered = q;
      }
      allAnswered = false;
    }
  }
  console.log();

  if (allAnswered) {
    printSummary(state);
    printPostAcceptanceWorkflow();
  } else if (nextUnanswered) {
    printQuestion(nextUnanswered);
    printAnswerCommand(prNumber, nextUnanswered.key);
  }
}

} // end isMainModule guard
