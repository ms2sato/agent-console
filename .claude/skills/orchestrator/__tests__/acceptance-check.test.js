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
  getQuestions,
  printQuestion,
  printSummary,
  printPostAcceptanceWorkflow,
  printProposedBehaviorCoverage,
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
  it('returns 11 questions (Q1-Q11)', () => {
    const questions = getQuestions(false);
    expect(questions).toHaveLength(11);
  });

  it('returns questions with keys q1-q11 in order', () => {
    const questions = getQuestions(false);
    const keys = questions.map(q => q.key);
    expect(keys).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11']);
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

  it('treats empty string answer as answered (not unanswered)', () => {
    const questions = [{ key: 'q1' }];
    const answers = { q1: '' };
    printSummary(answers, questions);
    const output = logs.join('\n');
    expect(output).toContain('Q1: OK');
    expect(output).not.toContain('Not answered');
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
