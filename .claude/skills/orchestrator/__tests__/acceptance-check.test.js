import { describe, it, expect } from 'bun:test';
import {
  categorizeFile,
  categorizeFiles,
  isTestFile,
  requiresTestCoverage,
  findTestFiles,
  detectIntegrationTestNeeds,
} from '../acceptance-check.js';

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

  it('does not trigger for client hooks (not in trigger patterns)', () => {
    const files = [
      'packages/client/src/hooks/useWorker.ts',
    ];
    const categories = categorizeFiles(files);
    const result = detectIntegrationTestNeeds(files, categories);
    expect(result).toBeNull();
  });
});
