#!/usr/bin/env node

/**
 * Orchestrator Acceptance Check (Interactive STDIN/STDOUT Mode)
 *
 * Full acceptance check requiring human judgment. Guides the Orchestrator
 * through Q1-Q8 in an interactive session via run_process.
 *
 * For mechanical pre-merge checks (CI), use preflight-check.js instead.
 *
 * Usage:
 *   node .claude/skills/orchestrator/acceptance-check.js <PR number>
 */

import {
  exec,
  getChangedFiles,
  categorizeFiles,
  findTestFiles,
  isTestFile,
  analyzePackageBoundaries,
  getLinkedIssueNumber,
  getIssueInfo,
  getAcceptanceCriteria,
  getCiStatus,
  detectIntegrationTestNeeds,
  getProposedBehavior,
  getPrDiff,
  checkProposedBehaviorCoverage,
} from './check-utils.js';

// --- Utility ---

function usage() {
  console.error('Usage:');
  console.error('  node .claude/skills/orchestrator/acceptance-check.js <PR number>');
  console.error('');
  console.error('This script runs a full interactive acceptance check (Q1-Q8).');
  console.error('For mechanical pre-merge checks, use preflight-check.js instead.');
  process.exit(1);
}

// --- STDIN reading (null-byte delimited) ---

/**
 * Creates a reader that reads null-byte delimited responses from a stream.
 * Uses a raw async iterator (via .next()) instead of for-await-of to avoid
 * destroying the stream on break — allowing multiple sequential reads.
 */
function createStdinReader(stdin = process.stdin) {
  let buffer = '';
  const iterator = stdin[Symbol.asyncIterator]();

  return async function readResponse() {
    while (true) {
      const nullIdx = buffer.indexOf('\0');
      if (nullIdx !== -1) {
        const answer = buffer.slice(0, nullIdx);
        buffer = buffer.slice(nullIdx + 1);
        return answer.trim();
      }
      const { value, done } = await iterator.next();
      if (done) break;
      buffer += Buffer.from(value).toString();
    }
    const answer = buffer;
    buffer = '';
    return answer.trim();
  };
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
  let proposedBehaviorCoverage = [];
  if (linkedIssue) {
    acceptanceCriteria = getAcceptanceCriteria(linkedIssue);
    const proposedItems = getProposedBehavior(linkedIssue);
    if (proposedItems.length > 0) {
      const prDiff = getPrDiff(prNumber);
      proposedBehaviorCoverage = checkProposedBehaviorCoverage(proposedItems, prDiff);
    }
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
    proposedBehaviorCoverage,
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

function printProposedBehaviorCoverage(proposedBehaviorCoverage, linkedIssue) {
  if (proposedBehaviorCoverage.length === 0) return;

  console.log(`[Issue #${linkedIssue} Proposed Behavior -> PR Diff Keyword Check]`);
  console.log();

  let hasWarning = false;
  for (let i = 0; i < proposedBehaviorCoverage.length; i++) {
    const { item, keywords, matched, matchedKeywords } = proposedBehaviorCoverage[i];
    const num = i + 1;
    if (matched) {
      console.log(`  ✅ ${num}. ${item}`);
      console.log(`     Matched keywords: ${matchedKeywords.join(', ')}`);
    } else if (keywords.length === 0) {
      console.log(`  ⬜ ${num}. ${item}`);
      console.log('     No extractable keywords — manual verification needed');
    } else {
      console.log(`  ⚠ ${num}. ${item}`);
      console.log(`     Expected keywords not found in diff: ${keywords.join(', ')}`);
      hasWarning = true;
    }
  }
  console.log();

  if (hasWarning) {
    console.log('  ⚠ Some Proposed Behavior items may not be implemented in this PR.');
    console.log('  Verify manually whether the PR addresses all proposed items.');
    console.log();
  }
}

function printAutoDetection(autoDetection) {
  const { categories, testFiles, testCoverage, boundaries, linkedIssue, acceptanceCriteria, proposedBehaviorCoverage, ciStatus, integrationTestNeeds } = autoDetection;

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

  // Proposed behavior coverage
  if (linkedIssue) {
    printProposedBehaviorCoverage(proposedBehaviorCoverage, linkedIssue);
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

function getQuestions(hasAcceptanceCriteria, { integrationTestMissing = false } = {}) {
  const q2Extra = integrationTestMissing
    ? '\n  ⚠ Integration test が未追加です。この変更で integration test が不要な理由を説明してください。不要な場合はその根拠を、必要な場合はエージェントに追加指示してください。'
    : '';
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
      text: 'Q2: Cross-Boundary Tests — Are WebSocket/REST/shared type contracts tested across package boundaries?' + q2Extra,
      focus: 'If the PR changes cross-package interfaces (shared types, WebSocket messages, REST endpoints), verify that integration tests exist to confirm both sides agree on the contract.' + (integrationTestMissing ? ' You MUST justify why integration tests are not needed, or instruct the agent to add them.' : ''),
      insufficient: '"Tests exist" (without identifying specific cross-boundary test cases)' + (integrationTestMissing ? '. Also insufficient: ignoring the ⚠ integration test warning without justification' : ''),
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
    {
      key: 'q8',
      text: 'Q8: Architectural Invariants — Walk through .claude/skills/architectural-invariants/SKILL.md. For each catalog entry (I-1..I-N) that could plausibly apply to this PR, explicitly answer whether the invariant holds.',
      focus: [
        'The catalog is deliberately short. The cost of walking it is low; the cost of missing an invariant is silent fragmentation / data loss / identity drift.',
        'High-priority entries to check for every PR that touches persistent state or I/O:',
        '  • I-1 I/O Addressing Symmetry — same identity → same read/write address (unless explicit asymmetry documented)',
        '  • I-2 Single Writer for Derived Values — one function is the source-of-truth for address/key/ID computation',
        '  • I-3 Identity Stability Across Time — identifiers survive restart/rename/restore',
        '  • I-4 State Persistence Survives Process Lifecycle — "success" returned only after durable commit',
        '  • I-5 Server as Source of Truth — user-meaningful state not in client localStorage',
        '  • I-6 Boundary Validation — external values validated with a schema before use',
        'If the PR does not touch persistent state, I/O, or shared identifiers, it is acceptable to answer "N/A — PR scope does not interact with any catalog entry" with a one-line justification.',
      ].join('\n  '),
      insufficient: '"Invariants look fine" (without walking the catalog)',
      sufficient: '"I-1: PR adds getCurrentOffset fallback branch. Verified via grep that both readWorkerOutput and getCurrentOffset route through computeSessionDataBaseDir — same identity yields same path. I-2: computeSessionDataBaseDir is the single helper, no inline path construction. I-3: sessionId is the stable identity and is unchanged. I-4: PR does not introduce new persistent state. I-5: N/A (server-only). I-6: job payloads validated via ZJobPayload schema at line 42."',
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

function printSummary(answers, questions) {
  console.log('=== Answer Summary ===');
  for (const q of questions) {
    if (q.key in answers) {
      const answer = answers[q.key];
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

// --- Interactive wizard mode ---

async function runWizard(prNumber, { stdin = process.stdin } = {}) {
  console.log(`=== PR #${prNumber} Acceptance Check ===\n`);

  const autoDetection = runAutoDetection(prNumber);
  printAutoDetection(autoDetection);

  const hasAcceptanceCriteria = autoDetection.acceptanceCriteria.length > 0;
  const integrationTestMissing = autoDetection.integrationTestNeeds
    && (autoDetection.integrationTestNeeds.isCrossPackage || autoDetection.integrationTestNeeds.hasSharedChanges)
    && !autoDetection.integrationTestNeeds.hasIntegrationTestInPr;
  const questions = getQuestions(hasAcceptanceCriteria, { integrationTestMissing });
  const answers = {};
  const readResponse = createStdinReader(stdin);

  for (const question of questions) {
    printQuestion(question);
    const answer = await readResponse();
    answers[question.key] = answer;
    console.log(`OK ${question.key.toUpperCase()} answered`);
    console.log();
  }

  printSummary(answers, questions);
  printPostAcceptanceWorkflow();
}

// --- Exports for testing ---
export {
  createStdinReader,
  runWizard,
  getQuestions,
  printQuestion,
  printSummary,
  printPostAcceptanceWorkflow,
  printProposedBehaviorCoverage,
};

// --- Main ---

const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('acceptance-check.js');
if (isMainModule) {
  const prNumber = process.argv[2];

  if (!prNumber || !/^\d+$/.test(prNumber)) {
    usage();
  }

  await runWizard(prNumber);
  process.exit(0);
}
