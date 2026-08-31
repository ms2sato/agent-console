import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import {
  categorizeFile,
  categorizeFiles,
  isTestFile,
  requiresTestCoverage,
  findTestFiles,
  detectIntegrationTestNeeds,
  getProposedBehavior,
  extractKeywords,
  checkProposedBehaviorCoverage,
} from '../check-utils.js';
import {
  createStdinReader,
  runWizard,
  getQuestions,
  printQuestion,
  printSummary,
  printPostAcceptanceWorkflow,
  printProposedBehaviorCoverage,
  printLanguageCheck,
  printAutoDetection,
  printAcceptanceCriteriaSection,
  isAnsweredValue,
  classifyCiEvidence,
} from '../acceptance-check.js';

// --- Helper: create a readable stream that emits null-byte terminated data ---

function createMockStdin(answers) {
  const chunks = answers.map(a => a + '\0');
  let index = 0;
  return new Readable({
    read() {
      if (index < chunks.length) {
        this.push(Buffer.from(chunks[index]));
        index++;
      } else {
        this.push(null);
      }
    },
  });
}

// --- Existing tests (unchanged) ---

describe('categorizeFile', () => {
  it('categorizes integration package files', () => {
    expect(categorizeFile('packages/integration/src/system-api-boundary.test.ts')).toBe('integration');
  });

  it('categorizes client files', () => {
    expect(categorizeFile('packages/client/src/components/Foo.tsx')).toBe('client');
  });

  it('categorizes server files', () => {
    expect(categorizeFile('packages/server/src/routes/index.ts')).toBe('server');
  });

  it('categorizes shared files', () => {
    expect(categorizeFile('packages/shared/src/types.ts')).toBe('shared');
  });

  it('categorizes test files (outside integration)', () => {
    expect(categorizeFile('packages/server/src/services/__tests__/foo.test.ts')).toBe('test');
  });

  it('categorizes other files', () => {
    expect(categorizeFile('CLAUDE.md')).toBe('other');
  });

  // Integration package takes priority over test detection
  it('integration files are not categorized as test even with .test. in name', () => {
    expect(categorizeFile('packages/integration/src/agent-form-boundary.test.tsx')).toBe('integration');
  });
});

describe('categorizeFiles', () => {
  it('includes integration category', () => {
    const files = [
      'packages/client/src/components/Foo.tsx',
      'packages/integration/src/foo.test.ts',
      'packages/server/src/routes/bar.ts',
    ];
    const categories = categorizeFiles(files);
    expect(categories.integration).toEqual(['packages/integration/src/foo.test.ts']);
    expect(categories.client).toEqual(['packages/client/src/components/Foo.tsx']);
    expect(categories.server).toEqual(['packages/server/src/routes/bar.ts']);
  });
});

describe('findTestFiles', () => {
  it('detects test coverage for production files', () => {
    const files = [
      'packages/server/src/routes/api.ts',
      'packages/server/src/routes/__tests__/api.test.ts',
    ];
    const result = findTestFiles(files);
    expect(result.testFiles).toEqual(['packages/server/src/routes/__tests__/api.test.ts']);
    expect(result.testCoverage).toHaveLength(1);
    expect(result.testCoverage[0].hasTest).toBe(true);
    expect(result.testCoverage[0].needsCoverage).toBe(true);
  });

  it('flags missing tests for production files', () => {
    const files = [
      'packages/client/src/components/MyComponent.tsx',
    ];
    const result = findTestFiles(files);
    expect(result.testCoverage).toHaveLength(1);
    expect(result.testCoverage[0].hasTest).toBe(false);
    expect(result.testCoverage[0].needsCoverage).toBe(true);
  });

  it('does not require coverage for non-matching files', () => {
    const files = [
      'packages/client/src/lib/utils.ts',
    ];
    const result = findTestFiles(files);
    expect(result.testCoverage[0].needsCoverage).toBe(false);
  });
});

describe('requiresTestCoverage — -types.ts(x) exemption', () => {
  it('exempts -types.ts files from coverage requirement', () => {
    expect(requiresTestCoverage('packages/server/src/services/internal-types.ts')).toBe(false);
    expect(requiresTestCoverage('packages/server/src/services/repository-lookup-types.ts')).toBe(false);
  });
  it('exempts -types.tsx files from coverage requirement', () => {
    expect(requiresTestCoverage('packages/client/src/components/foo-types.tsx')).toBe(false);
  });
  it('still requires coverage for regular files', () => {
    expect(requiresTestCoverage('packages/server/src/services/foo.ts')).toBe(true);
    expect(requiresTestCoverage('packages/client/src/components/Foo.tsx')).toBe(true);
  });
});

describe('detectIntegrationTestNeeds', () => {
  it('returns null when no triggering files exist', () => {
    const files = ['CLAUDE.md', 'package.json'];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).toBeNull();
  });

  it('detects component changes as integration test trigger', () => {
    const files = [
      'packages/client/src/components/FromIssueTab.tsx',
      'packages/client/src/components/__tests__/FromIssueTab.test.tsx',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].file).toBe('packages/client/src/components/FromIssueTab.tsx');
    expect(result.hasIntegrationTestInPr).toBe(false);
    expect(result.isCrossPackage).toBe(false);
  });

  it('detects cross-package changes', () => {
    const files = [
      'packages/client/src/components/SessionPanel.tsx',
      'packages/server/src/routes/session.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.isCrossPackage).toBe(true);
    expect(result.triggers).toHaveLength(2);
  });

  it('detects shared type changes', () => {
    const files = [
      'packages/shared/src/types.ts',
      'packages/client/src/components/Foo.tsx',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.hasSharedChanges).toBe(true);
  });

  it('recognizes integration test in PR', () => {
    const files = [
      'packages/client/src/components/AgentForm.tsx',
      'packages/integration/src/agent-form-boundary.test.tsx',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.hasIntegrationTestInPr).toBe(true);
  });

  it('flags server route changes as integration trigger', () => {
    const files = [
      'packages/server/src/routes/worker.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.triggers[0].reason).toContain('API route');
  });

  it('does not trigger for test-only files', () => {
    const files = [
      'packages/server/src/routes/__tests__/worker.test.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).toBeNull();
  });

  it('does not count non-test files in packages/integration as integration test', () => {
    const files = [
      'packages/client/src/components/AgentForm.tsx',
      'packages/integration/src/setup.ts',
      'packages/integration/src/test-utils.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).not.toBeNull();
    expect(result.hasIntegrationTestInPr).toBe(false);
  });

  it('does not trigger for client hooks (not in trigger patterns)', () => {
    const files = [
      'packages/client/src/hooks/useWorker.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).toBeNull();
  });
});

// --- New tests for STDIN/STDOUT wizard mode ---

describe('createStdinReader', () => {
  it('reads a single null-byte terminated response', async () => {
    const stdin = createMockStdin(['hello world']);
    const readResponse = createStdinReader(stdin);
    const result = await readResponse();
    expect(result).toBe('hello world');
  });

  it('trims whitespace from response', async () => {
    const stdin = createMockStdin(['  answer with spaces  ']);
    const readResponse = createStdinReader(stdin);
    const result = await readResponse();
    expect(result).toBe('answer with spaces');
  });

  it('reads multi-chunk response before null byte', async () => {
    let pushCount = 0;
    const stdin = new Readable({
      read() {
        if (pushCount === 0) {
          this.push(Buffer.from('first part '));
          pushCount++;
        } else if (pushCount === 1) {
          this.push(Buffer.from('second part\0'));
          pushCount++;
        } else {
          this.push(null);
        }
      },
    });
    const readResponse = createStdinReader(stdin);
    const result = await readResponse();
    expect(result).toBe('first part second part');
  });

  it('handles data after null byte by buffering for next read', async () => {
    // Single chunk contains two answers separated by null byte
    const stdin = createMockStdin(['first answer', 'second answer']);
    const readResponse = createStdinReader(stdin);
    const first = await readResponse();
    const second = await readResponse();
    expect(first).toBe('first answer');
    expect(second).toBe('second answer');
  });

  it('handles empty response before null byte', async () => {
    const stdin = createMockStdin(['']);
    const readResponse = createStdinReader(stdin);
    const result = await readResponse();
    expect(result).toBe('');
  });

  it('reads multiple sequential answers from same stream', async () => {
    const stdin = createMockStdin(['answer1', 'answer2', 'answer3']);
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('answer1');
    expect(await readResponse()).toBe('answer2');
    expect(await readResponse()).toBe('answer3');
  });

  it('handles multiple answers arriving in a single chunk', async () => {
    // Simulate all data arriving at once with multiple null bytes
    const stdin = new Readable({
      read() {
        this.push(Buffer.from('a1\0a2\0a3\0'));
        this.push(null);
      },
    });
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('a1');
    expect(await readResponse()).toBe('a2');
    expect(await readResponse()).toBe('a3');
  });
});

describe('getQuestions', () => {
  it('returns 12 questions (Q1-Q12)', () => {
    const questions = getQuestions(false);
    expect(questions).toHaveLength(12);
  });

  it('returns questions with keys q1-q12 in order', () => {
    const questions = getQuestions(false);
    const keys = questions.map(q => q.key);
    expect(keys).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12']);
  });

  it('Q10 references the Concerns Surfacing Discipline', () => {
    const questions = getQuestions(false);
    const q10 = questions.find(q => q.key === 'q10');
    expect(q10).toBeTruthy();
    expect(q10.text).toContain('Concerns Surfacing');
    expect(q10.text).toContain('HOLD');
    expect(q10.focus).toContain('core-responsibilities.md');
    expect(q10.focus).toContain('Concerns Surfacing Discipline');
  });

  it('Q9 references the glossary-maintenance rule', () => {
    const questions = getQuestions(false);
    const q9 = questions.find(q => q.key === 'q9');
    expect(q9.text).toContain('Glossary Integrity');
    expect(q9.focus).toContain('glossary-maintenance.md');
    expect(q9.focus).toContain('docs/glossary.md');
  });

  it('Q8 references the architectural-invariants skill catalog', () => {
    const questions = getQuestions(false);
    const q8 = questions.find(q => q.key === 'q8');
    expect(q8.text).toContain('architectural-invariants');
    expect(q8.focus).toContain('I-1');
    expect(q8.focus).toContain('I-6');
  });

  it('uses acceptance criteria variant for Q3 when criteria exist', () => {
    const questionsWithCriteria = getQuestions(true);
    const questionsWithoutCriteria = getQuestions(false);
    expect(questionsWithCriteria[2].text).toContain('Acceptance Criteria');
    expect(questionsWithoutCriteria[2].text).toContain('Domain Invariants');
  });

  it('each question has text, focus, insufficient, and sufficient fields', () => {
    const questions = getQuestions(false);
    for (const q of questions) {
      expect(q.text).toBeTruthy();
      expect(q.focus).toBeTruthy();
      expect(q.insufficient).toBeTruthy();
      expect(q.sufficient).toBeTruthy();
    }
  });

  it('adds integration test warning to Q2 when integrationTestMissing is true', () => {
    const questions = getQuestions(false, { integrationTestMissing: true });
    const q2 = questions.find(q => q.key === 'q2');
    expect(q2.text).toContain('Integration test が未追加です');
    expect(q2.focus).toContain('MUST justify');
    expect(q2.insufficient).toContain('integration test warning');
  });

  it('does not add integration test warning to Q2 when integrationTestMissing is false', () => {
    const questions = getQuestions(false, { integrationTestMissing: false });
    const q2 = questions.find(q => q.key === 'q2');
    expect(q2.text).not.toContain('Integration test が未追加です');
  });

  it('Q11 references the public-artifact language check', () => {
    const questions = getQuestions(false);
    const q11 = questions.find(q => q.key === 'q11');
    expect(q11).toBeTruthy();
    expect(q11.text).toContain('Public Artifacts Language');
    expect(q11.focus).toContain('workflow.md');
  });

  it('Q11 uses the FAILED variant when languageCheckFailed is true', () => {
    const questions = getQuestions(false, { languageCheckFailed: true });
    const q11 = questions.find(q => q.key === 'q11');
    expect(q11.text).toContain('FAILED');
  });

  it('Q11 uses the PASSED variant when languageCheckFailed is false', () => {
    const questions = getQuestions(false, { languageCheckFailed: false });
    const q11 = questions.find(q => q.key === 'q11');
    expect(q11.text).toContain('passed');
    expect(q11.text).not.toContain('FAILED');
  });

  it('Q12 requires shipping-path verification matching with HOLD on undocumented substitution', () => {
    const questions = getQuestions(false);
    const q12 = questions.find(q => q.key === 'q12');
    expect(q12).toBeTruthy();
    expect(q12.text).toContain('Shipping-Path Verification Match');
    expect(q12.text).toContain('joint-skip');
    expect(q12.text).toContain('HOLD');
    expect(q12.text).toContain('polarity');
    expect(q12.text).toContain('retroactively');
    expect(q12.focus).toContain('pre-pr-completeness.md');
  });
});

describe('printQuestion', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints question key, text, focus, and examples', () => {
    const question = {
      key: 'q1',
      text: 'Q1: Test question',
      focus: 'Test focus',
      insufficient: 'Bad answer',
      sufficient: 'Good answer',
    };
    printQuestion(question);
    const output = logs.join('\n');
    expect(output).toContain('--- Q1 ---');
    expect(output).toContain('Q1: Test question');
    expect(output).toContain('Focus: Test focus');
    expect(output).toContain('Insufficient answer: Bad answer');
    expect(output).toContain('Sufficient answer: Good answer');
  });
});

describe('printSummary', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints answered questions with OK prefix', () => {
    const questions = [{ key: 'q1' }, { key: 'q2' }];
    const answers = { q1: 'My answer', q2: 'Another answer' };
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: OK My answer');
    expect(output).toContain('Q2: OK Another answer');
  });

  it('truncates long answers to 100 chars', () => {
    const questions = [{ key: 'q1' }];
    const longAnswer = 'x'.repeat(150);
    const answers = { q1: longAnswer };
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: OK ' + 'x'.repeat(100) + '...');
  });

  it('prints unanswered questions with -- prefix', () => {
    const questions = [{ key: 'q1' }];
    const answers = {};
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: -- Not answered');
  });

  // Flipped as part of the D1 fix: an empty (or whitespace-only) answer
  // is exactly the shape a closed stdin produces for every question, and
  // pre-fix this was reported identically to a real answer. See
  // `isAnsweredValue` in acceptance-check.js.
  it('treats an empty string answer as UNANSWERED (D1 fix)', () => {
    const questions = [{ key: 'q1' }];
    const answers = { q1: '' };
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: -- Not answered');
    expect(output).not.toContain('Q1: OK');
  });

  it('treats a whitespace-only answer as UNANSWERED', () => {
    const questions = [{ key: 'q1' }];
    const answers = { q1: '   ' };
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: -- Not answered');
  });

  // D2: CI retrieval failure folds into the same visible-unanswered
  // machinery, rather than a warning printed once and then ignored.
  it('prints a CI-STATUS not-answered line when ciStatus is null (retrieval failed)', () => {
    printSummary({}, [], { ciStatus: null });
    const output = logs.join('\n');
    expect(output).toContain('CI-STATUS: -- Not answered');
  });

  it('prints a CI-STATUS OK line when ciStatus has evidence', () => {
    printSummary({}, [], { ciStatus: { allGreen: true, checks: [{ name: 'test', bucket: 'pass' }] } });
    const output = logs.join('\n');
    expect(output).toContain('CI-STATUS: OK');
  });

  // D2 amendment: an empty rollup is a real, non-null result distinct from
  // both "retrieval failed" and "has evidence" — must not print OK.
  //
  // Mutation reach (measured): forcing the `ciEvidence === 'no-checks-yet'`
  // branch to `false` (falling through to the OK/allGreen branch) makes
  // this test fail with "CI-STATUS: OK (not all green ...)" instead of the
  // expected not-answered line.
  it('prints a CI-STATUS not-answered line, distinct wording, when ciStatus has an empty checks array (no checks reported yet)', () => {
    printSummary({}, [], { ciStatus: { allGreen: false, checks: [] } });
    const output = logs.join('\n');
    expect(output).toContain('CI-STATUS: -- Not answered');
    expect(output).toContain('no checks reported on this PR yet');
    expect(output).not.toContain('could not retrieve');
  });

  it('prints no CI-STATUS line when ciStatus is not passed at all (backward compatible)', () => {
    const questions = [{ key: 'q1' }];
    printSummary({ q1: 'answer' }, questions);
    const output = logs.join('\n');
    expect(output).not.toContain('CI-STATUS');
  });
});

describe('printPostAcceptanceWorkflow', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints post-acceptance workflow steps', () => {
    printPostAcceptanceWorkflow();
    const output = logs.join('\n');
    expect(output).toContain('Post-Acceptance Workflow');
    expect(output).toContain('Do NOT delete the worktree');
  });
});

// --- extractKeywords tests ---

describe('extractKeywords', () => {
  it('extracts backtick-enclosed terms', () => {
    const keywords = extractKeywords('Use `gh issue view` to fetch body');
    expect(keywords).toContain('gh issue view');
  });

  it('extracts uppercase abbreviations', () => {
    const keywords = extractKeywords('Add UI and API support');
    expect(keywords).toContain('UI');
    expect(keywords).toContain('API');
  });

  it('extracts camelCase identifiers', () => {
    const keywords = extractKeywords('Call getProposedBehavior from the check');
    expect(keywords).toContain('getProposedBehavior');
  });

  it('extracts PascalCase identifiers', () => {
    const keywords = extractKeywords('Use ProposedBehavior type');
    expect(keywords).toContain('ProposedBehavior');
  });

  it('deduplicates keywords', () => {
    const keywords = extractKeywords('API and API again');
    const apiCount = keywords.filter(k => k === 'API').length;
    expect(apiCount).toBe(1);
  });

  it('returns empty array for text with no extractable keywords', () => {
    const keywords = extractKeywords('simple text with no special words');
    expect(keywords).toEqual([]);
  });

  it('extracts MCP as keyword', () => {
    const keywords = extractKeywords('Expose via MCP tool');
    expect(keywords).toContain('MCP');
  });
});

// --- checkProposedBehaviorCoverage tests ---

describe('checkProposedBehaviorCoverage', () => {
  it('marks items as matched when keywords appear in diff', () => {
    const items = ['Add `getProposedBehavior` function'];
    const diff = 'export function getProposedBehavior(issueNumber) {';
    const result = checkProposedBehaviorCoverage(items, diff);
    expect(result).toHaveLength(1);
    expect(result[0].matched).toBe(true);
    expect(result[0].matchedKeywords).toContain('getProposedBehavior');
  });

  it('marks items as unmatched when no keywords in diff', () => {
    const items = ['Add UI component for dashboard'];
    const diff = 'export function serverHandler() {}';
    const result = checkProposedBehaviorCoverage(items, diff);
    expect(result).toHaveLength(1);
    expect(result[0].matched).toBe(false);
  });

  it('handles items with no extractable keywords', () => {
    const items = ['do something simple'];
    const diff = 'some diff content';
    const result = checkProposedBehaviorCoverage(items, diff);
    expect(result).toHaveLength(1);
    expect(result[0].matched).toBe(false);
    expect(result[0].keywords).toEqual([]);
  });

  it('handles multiple items with mixed coverage', () => {
    const items = [
      'Add API endpoint',
      'Add UI component',
    ];
    const diff = 'app.get("/api/proposed", handler);\nAPI route added';
    const result = checkProposedBehaviorCoverage(items, diff);
    expect(result[0].matched).toBe(true);
    expect(result[1].matched).toBe(false);
  });

  it('returns empty array for empty items', () => {
    const result = checkProposedBehaviorCoverage([], 'some diff');
    expect(result).toEqual([]);
  });
});

// --- printAutoDetection: comment-only exemption display ---
//
// Before this fix, a comment-only-exempted file (needsCoverage: false,
// isCommentOnly: true) fell into the same `else` branch as a file that
// simply doesn't match any coverage pattern, printed as "skipped (not in
// coverage patterns)". That wording is misleading for a file that DID match
// a pattern and was exempted for a specific, auditable reason — this test
// pins the distinct "exempted (comment-only diff)" wording.

function minimalAutoDetection(testCoverage, overrides = {}) {
  return {
    categories: { client: [], server: [], shared: [], integration: [], test: [], other: [] },
    testFiles: [],
    productionFiles: [],
    testCoverage,
    boundaries: [],
    linkedIssue: null,
    acceptanceCriteriaState: { state: 'absent', items: [] },
    proposedBehaviorCoverage: [],
    ciStatus: null,
    integrationTestNeeds: null,
    languageCheck: null,
    ...overrides,
  };
}

describe('printAutoDetection — Production File Test Coverage wording', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('reports a comment-only-exempted file distinctly from a not-in-pattern file', () => {
    printAutoDetection(minimalAutoDetection([
      { file: 'packages/server/src/services/foo.ts', hasTest: false, expectedTestPath: '', needsCoverage: false, isCommentOnly: true },
      { file: 'packages/server/src/lib/bar.ts', hasTest: false, expectedTestPath: '', needsCoverage: false, isCommentOnly: false },
    ]));
    const output = logs.join('\n');
    expect(output).toContain('➖ packages/server/src/services/foo.ts -> exempted (comment-only diff)');
    expect(output).toContain('⬜ packages/server/src/lib/bar.ts -> skipped (not in coverage patterns)');
  });

  it('still reports a genuine gap as NO TEST even when other files are exempted', () => {
    printAutoDetection(minimalAutoDetection([
      { file: 'packages/server/src/services/foo.ts', hasTest: false, expectedTestPath: 'packages/server/src/services/__tests__/foo.test.ts', needsCoverage: true, isCommentOnly: false },
    ]));
    const output = logs.join('\n');
    expect(output).toContain('❌ packages/server/src/services/foo.ts -> NO TEST');
  });
});

// --- printProposedBehaviorCoverage tests ---

describe('printProposedBehaviorCoverage', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints nothing when coverage array is empty', () => {
    printProposedBehaviorCoverage([], '123');
    expect(logs).toHaveLength(0);
  });

  it('prints matched items with checkmark', () => {
    const coverage = [
      { item: 'Add API support', keywords: ['API'], matched: true, matchedKeywords: ['API'] },
    ];
    printProposedBehaviorCoverage(coverage, '42');
    const output = logs.join('\n');
    expect(output).toContain('✅');
    expect(output).toContain('Add API support');
    expect(output).toContain('Matched keywords: API');
  });

  it('prints unmatched items with warning', () => {
    const coverage = [
      { item: 'Add UI component', keywords: ['UI'], matched: false, matchedKeywords: [] },
    ];
    printProposedBehaviorCoverage(coverage, '42');
    const output = logs.join('\n');
    expect(output).toContain('⚠');
    expect(output).toContain('Add UI component');
    expect(output).toContain('Expected keywords not found');
  });

  it('prints items with no keywords as manual verification needed', () => {
    const coverage = [
      { item: 'do something', keywords: [], matched: false, matchedKeywords: [] },
    ];
    printProposedBehaviorCoverage(coverage, '42');
    const output = logs.join('\n');
    expect(output).toContain('⬜');
    expect(output).toContain('manual verification needed');
  });

  it('includes issue number in header', () => {
    const coverage = [
      { item: 'Add API', keywords: ['API'], matched: true, matchedKeywords: ['API'] },
    ];
    printProposedBehaviorCoverage(coverage, '612');
    const output = logs.join('\n');
    expect(output).toContain('Issue #612');
    expect(output).toContain('Proposed Behavior');
  });
});

// --- Q10 defer safety check (Sprint 2026-07-06 retro: #931 -> #951 root cause) ---

describe('getQuestions Q10 defer safety', () => {
  function findQ10() {
    const questions = getQuestions(true);
    return questions.find((q) => q.key === 'q10');
  }

  it('Q10 exists and is the concerns-surfacing gate', () => {
    const q10 = findQ10();
    expect(q10).toBeDefined();
    expect(q10.text).toContain('Concerns Surfacing');
  });

  it('Q10 text prompts a code-level check before deferring a concern', () => {
    const q10 = findQ10();
    // The pre-fix Q10 walked a 5-step procedure and did not explicitly require
    // a code-level check when a concern was deferred. After #931 -> #951, defer
    // safety must call out (a) elevation path and (b) dogfood-only reachability
    // explicitly, and it must be a step in the mandatory walk.
    expect(q10.text).toMatch(/DEFER/);
    expect(q10.text).toMatch(/elevation path/i);
    expect(q10.text).toMatch(/dogfood/i);
  });

  it('Q10 focus lists the code-level substeps for defer safety', () => {
    const q10 = findQ10();
    expect(q10.focus).toMatch(/shouldElevateForUser|runAsUser|requestUsername/);
    expect(q10.focus).toMatch(/read.*(function body|code)/i);
  });

  it('Q10 focus includes the #931 -> #951 lesson', () => {
    const q10 = findQ10();
    expect(q10.focus).toMatch(/#931/);
    expect(q10.focus).toMatch(/#951/);
  });

  it('Q10 insufficient example flags "elevation-first" without reading the code', () => {
    const q10 = findQ10();
    expect(q10.insufficient).toMatch(/elevation/i);
  });
});

// --- printLanguageCheck: distinguish real violations from script-side errors ---
// Sprint 2026-07-01 observed "❌ FAIL — 0 violation(s) found" false alarms in
// two acceptance checks. Pre-fix logic printed FAIL whenever exitCode != 0,
// even when the script produced no violation lines (a script-side error).

describe('printLanguageCheck', () => {
  let logs;
  let logSpy;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg ?? '')));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints ✅ when exitCode is 0', () => {
    printLanguageCheck({ exitCode: 0, stdout: '', stderr: '', spawnFailed: false });
    const output = logs.join('\n');
    expect(output).toContain('✅');
    expect(output).not.toContain('❌');
  });

  it('prints ❌ FAIL with count when stdout has violation lines', () => {
    printLanguageCheck({
      exitCode: 1,
      stdout: 'docs/glossary.md:82:5 あ U+3042\ndocs/glossary.md:83:5 い U+3044\n',
      stderr: '',
      spawnFailed: false,
    });
    const output = logs.join('\n');
    expect(output).toContain('❌ FAIL — 2 violation(s) found');
    expect(output).toContain('docs/glossary.md:82:5');
  });

  it('prints ⚠ INCONCLUSIVE (not FAIL) when spawnFailed is true', () => {
    // Regression guard: pre-fix logic already handled spawnFailed via the
    // exitCode 1 fallback and printed "❌ FAIL — 0 violation(s) found" because
    // stdout was empty. The fix must clearly distinguish spawn failure as
    // inconclusive.
    printLanguageCheck({
      exitCode: 1,
      stdout: '',
      stderr: "Failed to spawn 'bun': ENOENT",
      spawnFailed: true,
    });
    const output = logs.join('\n');
    expect(output).not.toContain('❌ FAIL');
    expect(output).toMatch(/(⚠|inconclusive|manually)/i);
  });

  it('does NOT print ❌ FAIL when exitCode != 0 but stdout is empty (script-side error)', () => {
    // Direct regression case for the Sprint 2026-07-01 false alarm.
    printLanguageCheck({
      exitCode: 2,
      stdout: '',
      stderr: 'TypeError: cannot read property foo of undefined',
      spawnFailed: false,
    });
    const output = logs.join('\n');
    expect(output).not.toContain('❌ FAIL — 0 violation(s)');
    expect(output).toMatch(/script-side error|no violation output|investigate/i);
    expect(output).toContain('exited with code 2');
  });
});

// --- isAnsweredValue: the D1 fix's single source of truth for "was this
// question actually answered" ---

describe('isAnsweredValue', () => {
  it('returns false for an empty string', () => {
    expect(isAnsweredValue('')).toBe(false);
  });

  it('returns false for a whitespace-only string', () => {
    expect(isAnsweredValue('   \t  ')).toBe(false);
  });

  it('returns false for undefined (key never set)', () => {
    expect(isAnsweredValue(undefined)).toBe(false);
  });

  it('returns true for a non-empty string with real content', () => {
    expect(isAnsweredValue('a real answer')).toBe(true);
  });

  it('returns true for a string that is only whitespace around real content', () => {
    expect(isAnsweredValue('  answer  ')).toBe(true);
  });
});

// --- classifyCiEvidence: D2 amendment — outcome unified across the two
// no-evidence states, label kept distinct (Architect contract ruling on a
// CodeRabbit finding against this fix's original allGreen-only patch). ---

describe('classifyCiEvidence', () => {
  it('classifies null as retrieval-failed', () => {
    expect(classifyCiEvidence(null)).toBe('retrieval-failed');
  });

  // The boundary CodeRabbit's finding was about: a genuinely-retrieved,
  // genuinely-empty rollup must not read as "has evidence".
  it('classifies a non-null result with an empty checks array as no-checks-yet', () => {
    expect(classifyCiEvidence({ checks: [] })).toBe('no-checks-yet');
  });

  it('classifies a non-empty checks array as has-evidence', () => {
    expect(classifyCiEvidence({ checks: [{ name: 'test', bucket: 'pass' }] })).toBe('has-evidence');
  });
});

// --- printAutoDetection: [CI Status] section three-way display ---
// linkedIssue is left at its default (null) throughout — see
// printAcceptanceCriteriaSection's describe block below for why a truthy
// linkedIssue would make these tests depend on live network / `gh` auth.

describe('printAutoDetection — [CI Status] section', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('retrieval failure: prints "Could not retrieve"', () => {
    printAutoDetection(minimalAutoDetection([], { ciStatus: null }));
    const output = logs.join('\n');
    expect(output).toContain('Could not retrieve CI status');
  });

  // Mutation reach (measured): reverting classifyCiEvidence's
  // `checks.length === 0` branch to fall through to `has-evidence` makes
  // this test fail — it asserts the distinct "No checks have reported"
  // wording and the ABSENCE of "Could not retrieve", which the pre-D2-
  // amendment code could not have produced for this fixture (it would
  // have printed the allGreen branch instead, since allGreen was
  // vacuously true for an empty rollup pre-fix).
  it('no checks yet (empty rollup): prints a distinct message, never "Could not retrieve"', () => {
    printAutoDetection(minimalAutoDetection([], {
      ciStatus: { allGreen: false, checks: [], failed: [], pending: [], passed: [] },
    }));
    const output = logs.join('\n');
    expect(output).toContain('No checks have reported on this PR');
    expect(output).not.toContain('Could not retrieve CI status');
  });

  it('has evidence, all green: prints the passed-count message', () => {
    printAutoDetection(minimalAutoDetection([], {
      ciStatus: { allGreen: true, checks: [{ name: 'test', bucket: 'pass' }], failed: [], pending: [], passed: [{ name: 'test', bucket: 'pass' }] },
    }));
    const output = logs.join('\n');
    expect(output).toContain('All checks passed (1 checks)');
  });
});

// --- printAcceptanceCriteriaSection: Acceptance Criteria three-valued
// detection (D3) ---
//
// Tested via the extracted `printAcceptanceCriteriaSection` directly, not
// through `printAutoDetection`. `printAutoDetection` unconditionally calls
// `printIntegrationTestAdequacy(linkedIssue)`, which shells out to the real
// `gh issue view` for any truthy `linkedIssue` — going through the full
// function for a D3-only assertion would make these tests silently depend
// on live network / `gh` auth. `printAcceptanceCriteriaSection` was pulled
// out of `printAutoDetection` (mirroring the existing
// printIntegrationTestCoverage / printProposedBehaviorCoverage /
// printLanguageCheck extraction pattern) specifically so this state
// display is testable in isolation.

describe('printAcceptanceCriteriaSection', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('state "checklist": prints the criterion -> test mapping prompt', () => {
    printAcceptanceCriteriaSection('1418', { state: 'checklist', items: ['First criterion', 'Second criterion'] });
    const output = logs.join('\n');
    expect(output).toContain('Acceptance Criteria -> Test Coverage Check');
    expect(output).toContain('Criterion 1: First criterion');
    expect(output).toContain('Criterion 2: Second criterion');
  });

  // The distinct, visible state D3 introduces: a heading exists, but no
  // checkbox items were found under it. This must never read the same as
  // "none found" — that collapse is exactly the defect this state exists
  // to report.
  it('state "prose": prints a MANUAL-mapping notice distinct from "none found"', () => {
    printAcceptanceCriteriaSection('1418', { state: 'prose', items: [] });
    const output = logs.join('\n');
    expect(output).toContain('AC section found but not in checklist form');
    expect(output).toContain('MANUAL');
    expect(output).not.toContain('No acceptance criteria (checklist) found');
  });

  it('state "absent": prints "no acceptance criteria found"', () => {
    printAcceptanceCriteriaSection('1418', { state: 'absent', items: [] });
    const output = logs.join('\n');
    expect(output).toContain('No acceptance criteria (checklist) found');
    expect(output).not.toContain('MANUAL');
  });

  // D3 amendment (Architect ruling): a heading with no content under it
  // gets its own message, distinct from both "prose" (MANUAL) — since
  // "Q3 mapping is MANUAL" over zero criteria is vacuous — and from the
  // plain "absent" wording, even though its consequence (Q3 falls back to
  // manual) is identical to "absent".
  //
  // Mutation reach (measured): merging the 'empty-heading' branch into the
  // trailing `else` (i.e. deleting the dedicated branch) makes this test
  // fail — it would print the "No acceptance criteria (checklist) found"
  // wording instead of the transcription-accident wording.
  it('state "empty-heading": prints a distinct transcription-accident message, not "prose" MANUAL wording or plain "absent" wording', () => {
    printAcceptanceCriteriaSection('1418', { state: 'empty-heading', items: [] });
    const output = logs.join('\n');
    expect(output).toContain('AC heading present but the section is EMPTY');
    expect(output).toContain('transcription accident');
    expect(output).not.toContain('MANUAL');
    expect(output).not.toContain('No acceptance criteria (checklist) found');
  });

  it('no linked Issue: prints the "no linked Issue" notice regardless of state', () => {
    printAcceptanceCriteriaSection(null, { state: 'absent', items: [] });
    const output = logs.join('\n');
    expect(output).toContain('No linked Issue');
  });
});

// --- runWizard: D1 (self-answer) + D2 (CI status) exit-code polarity ---
//
// `autoDetection` is injected directly (the DI seam added alongside
// runWizard's `stdin` option) so these tests never shell out to `gh`. A
// green CI status is used as the baseline for tests that are not
// specifically about D2, so a D1-only failure isn't masked by an
// unrelated D2 failure and vice versa.

// `checks` intentionally non-empty — an empty `checks` array now classifies
// as the distinct "no-checks-yet" evidence state (D2 amendment), not
// "has-evidence" / allGreen. See classifyCiEvidence's doc comment.
const GREEN_CI = { allGreen: true, checks: [{ name: 'test', bucket: 'pass' }], failed: [], pending: [], passed: [{ name: 'test', bucket: 'pass' }] };

function baseAutoDetectionForWizard(overrides = {}) {
  return minimalAutoDetection([], { ciStatus: GREEN_CI, ...overrides });
}

describe('runWizard — D1 self-answer + D2 CI status', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // D1 polarity, pre-fix half: this is exactly the closed-stdin shape
  // (`< /dev/null`) the Issue reports. Pre-fix, this produced twelve `OK`
  // lines and exit 0; the assertions below are what the pre-fix code
  // fails.
  //
  // Mutation reach (measured): swapping the exit-code combinator from
  // `unanswered.length > 0 || ciRetrievalFailed` to `&&` makes this test
  // (and the partial-answers and CI-retrieval-failed tests below) fail —
  // all three assert exitCode 1 from only one side of the OR being true.
  it('closed stdin (no answers at all): all 12 questions unanswered, exitCode 1', async () => {
    const stdin = createMockStdin([]);
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard() });
    expect(result.exitCode).toBe(1);
    expect(result.unanswered).toHaveLength(12);
    expect(result.ciRetrievalFailed).toBe(false);
  });

  it('partial answers (3 of 12): the 3 are excluded from unanswered, the other 9 are listed, exitCode 1', async () => {
    const stdin = createMockStdin(['real answer one', 'real answer two', 'real answer three']);
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard() });
    expect(result.exitCode).toBe(1);
    expect(result.unanswered).toHaveLength(9);
    expect(result.unanswered).not.toContain('q1');
    expect(result.unanswered).not.toContain('q2');
    expect(result.unanswered).not.toContain('q3');
    expect(result.unanswered).toContain('q4');
  });

  // D1 polarity, post-fix half: full answers must still pass. Without this,
  // a fix that marked everything unanswered unconditionally would also
  // pass the closed-stdin test above for the wrong reason.
  it('all 12 questions answered with real content: exitCode 0, unanswered is empty', async () => {
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard() });
    expect(result.exitCode).toBe(0);
    expect(result.unanswered).toHaveLength(0);
  });

  // D2 polarity: retrieval failure must fail the run even when every
  // question was answered — "could not retrieve" can never coexist with
  // exit 0.
  it('CI status retrieval failed (ciStatus null) with all questions answered: exitCode 1, ciRetrievalFailed true', async () => {
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard({ ciStatus: null }) });
    expect(result.exitCode).toBe(1);
    expect(result.ciRetrievalFailed).toBe(true);
    expect(result.unanswered).toHaveLength(0);
  });

  // D2 polarity, post-fix half: a successfully retrieved (even non-green)
  // CI status must not by itself fail the run through the D2 mechanism —
  // only retrieval failure does. (allGreen: false here to prove the
  // distinction; D2 does not gate on allGreen, only on retrieval success.)
  it('CI status retrieved but not all green: exitCode still driven by answers, not by allGreen', async () => {
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    const notGreenCi = { allGreen: false, checks: [{ name: 'test', bucket: 'fail' }], failed: [{ name: 'test' }], pending: [], passed: [] };
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard({ ciStatus: notGreenCi }) });
    expect(result.ciRetrievalFailed).toBe(false);
    expect(result.ciNoChecksYet).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  // D2 amendment (Architect contract ruling, after a CodeRabbit finding
  // against this fix): an empty rollup — genuinely retrieved, genuinely
  // zero checks reported — must fold into the same non-zero-exit outcome
  // as a retrieval failure, but keep a DIFFERENT reason string, because
  // calling it "could not retrieve" would misdescribe what happened.
  //
  // Mutation reach (measured): dropping `|| ciNoChecksYet` from the
  // exit-code gate makes this test fail (exitCode reverts to 0); dropping
  // the `else if (ciNoChecksYet)` branch (falling through to no reason
  // pushed) makes the reason-string assertion fail while exitCode stays
  // correct — the two assertions are not redundant with each other.
  it('CI status retrieved with an empty checks array (no checks reported yet): exitCode 1, ciNoChecksYet true, ciRetrievalFailed false', async () => {
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    const noChecksYetCi = { allGreen: false, checks: [], failed: [], pending: [], passed: [] };
    const logs = [];
    logSpy.mockImplementation((...args) => logs.push(args.join(' ')));
    const result = await runWizard('999', { stdin, autoDetection: baseAutoDetectionForWizard({ ciStatus: noChecksYetCi }) });
    expect(result.exitCode).toBe(1);
    expect(result.ciNoChecksYet).toBe(true);
    expect(result.ciRetrievalFailed).toBe(false);
    const output = logs.join('\n');
    expect(output).toContain('no CI checks have reported on this PR yet');
    expect(output).not.toContain('CI status could not be retrieved');
  });

  // D3 wiring: a "prose" AC state must drive Q3 to the manual
  // (Domain Invariants) variant, exactly like "absent" — never like
  // "checklist". This is the runWizard-level pin; check-utils.test.js pins
  // the detection itself and the printAcceptanceCriteriaSection describe
  // block above pins the display message.
  //
  // Mutation reach (measured): weakening the wiring from
  // `acceptanceCriteriaState.state === 'checklist'` to `!== 'absent'`
  // (i.e. treating "prose" as truthy the same as "checklist") makes this
  // test fail — it asserts the "Domain Invariants" (manual) Q3 text and
  // the absence of the "Acceptance Criteria" (checklist) Q3 text.
  it('acceptanceCriteriaState "prose" drives Q3 to the manual variant, not the checklist variant', async () => {
    const logs = [];
    logSpy.mockImplementation((...args) => logs.push(args.join(' ')));
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    // linkedIssue is intentionally left at its default (null) — Q3's
    // manual-vs-checklist wiring depends only on acceptanceCriteriaState,
    // never on linkedIssue itself, and a truthy linkedIssue here would make
    // runWizard's printAutoDetection -> printIntegrationTestAdequacy shell
    // out to the real `gh issue view` (see printAcceptanceCriteriaSection's
    // describe block above for the same hazard).
    const autoDetection = baseAutoDetectionForWizard({
      acceptanceCriteriaState: { state: 'prose', items: [] },
    });
    await runWizard('999', { stdin, autoDetection });
    const output = logs.join('\n');
    expect(output).toContain('Q3: Domain Invariants');
    expect(output).not.toContain('Q3: Acceptance Criteria');
  });

  // D3 amendment: 'empty-heading' shares 'prose'/'absent's consequence
  // (Q3 falls back to manual) — confirmed here at the wiring level, same
  // shape as the 'prose' test above.
  it('acceptanceCriteriaState "empty-heading" also drives Q3 to the manual variant', async () => {
    const logs = [];
    logSpy.mockImplementation((...args) => logs.push(args.join(' ')));
    const answers = Array.from({ length: 12 }, (_, i) => `real answer ${i + 1}`);
    const stdin = createMockStdin(answers);
    const autoDetection = baseAutoDetectionForWizard({
      acceptanceCriteriaState: { state: 'empty-heading', items: [] },
    });
    await runWizard('999', { stdin, autoDetection });
    const output = logs.join('\n');
    expect(output).toContain('Q3: Domain Invariants');
    expect(output).not.toContain('Q3: Acceptance Criteria');
  });
});
