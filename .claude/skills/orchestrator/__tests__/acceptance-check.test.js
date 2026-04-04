import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import {
  categorizeFile,
  categorizeFiles,
  isTestFile,
  requiresTestCoverage,
  findTestFiles,
  detectIntegrationTestNeeds,
  createStdinReader,
  getQuestions,
  printQuestion,
  printSummary,
  printPostAcceptanceWorkflow,
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
  it('returns 7 questions', () => {
    const questions = getQuestions(false);
    expect(questions).toHaveLength(7);
  });

  it('returns questions with keys q1-q7', () => {
    const questions = getQuestions(false);
    const keys = questions.map(q => q.key);
    expect(keys).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
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
