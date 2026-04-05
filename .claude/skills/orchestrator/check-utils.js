/**
 * Shared utilities for preflight-check.js and acceptance-check.js
 *
 * Contains file categorization, test coverage detection, integration test
 * analysis, and package boundary analysis.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// --- Utility functions ---

export function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getChangedFiles(prNumber) {
  const result = exec(`gh pr diff ${prNumber} --name-only`);
  if (result === null) {
    console.error(`Error: Could not retrieve diff for PR #${prNumber}. Please verify the gh command and PR number.`);
    process.exit(1);
  }
  return result.split('\n').filter(Boolean);
}

export function getLocalChangedFiles() {
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

export function categorizeFile(filePath) {
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

export function categorizeFiles(files) {
  const categories = { client: [], server: [], shared: [], integration: [], test: [], other: [] };
  for (const file of files) {
    const category = categorizeFile(file);
    categories[category].push(file);
  }
  return categories;
}

// --- Test file detection ---

// Patterns that require test coverage (production code only)
export const COVERAGE_PATTERNS = [
  /^packages\/server\/src\/routes\/.+\.ts$/,
  /^packages\/server\/src\/services\/.+\.ts$/,
  /^packages\/client\/src\/hooks\/.+\.ts$/,
  /^packages\/client\/src\/components\/.+\.tsx$/,
  /^packages\/shared\/src\/.+\.ts$/,
];

// Files excluded from coverage requirements (no runtime logic to test)
const COVERAGE_EXCLUSIONS = [
  /^packages\/shared\/src\/types\/.+\.ts$/,
];

export function isTestFile(filePath) {
  return filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/');
}

export function requiresTestCoverage(filePath) {
  if (isTestFile(filePath)) return false;
  if (COVERAGE_EXCLUSIONS.some(pattern => pattern.test(filePath))) return false;
  return COVERAGE_PATTERNS.some(pattern => pattern.test(filePath));
}

export function findTestFiles(changedFiles) {
  const testFiles = [];
  const productionFiles = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      testFiles.push(file);
    } else if (file.match(/\.(ts|tsx|js|jsx)$/)) {
      productionFiles.push(file);
    }
  }

  const testCoverage = [];
  for (const prodFile of productionFiles) {
    const ext = prodFile.match(/\.(ts|tsx|js|jsx)$/)[0];
    const baseName = prodFile.replace(/\.(ts|tsx|js|jsx)$/, '');
    const dir = baseName.substring(0, baseName.lastIndexOf('/'));
    const fileName = baseName.substring(baseName.lastIndexOf('/') + 1);

    const testPattern = new RegExp(`\\.(test|spec)\\.(ts|tsx|js|jsx)$`);
    const hasTest = testFiles.some(tf => {
      if (!testPattern.test(tf)) return false;
      const tfDir = tf.substring(0, tf.lastIndexOf('/'));
      const tfFileName = tf.substring(tf.lastIndexOf('/') + 1);
      const tfBaseName = tfFileName.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '');
      if (tfBaseName !== fileName) return false;
      return tfDir === dir || tfDir === dir + '/__tests__';
    });

    const needsCoverage = requiresTestCoverage(prodFile);
    const expectedTestPath = dir + '/__tests__/' + fileName + '.test' + (ext === '.tsx' ? '.tsx' : '.ts');
    testCoverage.push({ file: prodFile, hasTest, expectedTestPath, needsCoverage });
  }

  return { testFiles, productionFiles, testCoverage };
}

// --- Integration test detection ---

export const INTEGRATION_TRIGGER_PATTERNS = [
  { pattern: /^packages\/client\/src\/components\/.+\.tsx$/, reason: 'UI component (may involve state transitions or forms)' },
  { pattern: /^packages\/server\/src\/routes\/.+\.ts$/, reason: 'API route (client-server contract)' },
  { pattern: /^packages\/shared\/src\/.+\.ts$/, reason: 'shared type (cross-package contract)' },
];

export function listExistingIntegrationTests() {
  const dir = 'packages/integration/src';
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
      .map(f => dir + '/' + f);
  } catch {
    return [];
  }
}

export function detectIntegrationTestNeeds(changedFiles, categories) {
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

  const hasIntegrationTestInPr = changedFiles.some(
    f => f.startsWith('packages/integration/') && isTestFile(f)
  );

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

export function analyzePackageBoundaries(categories) {
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

export function getLinkedIssueNumber(prNumber) {
  const result = exec(`gh pr view ${prNumber} --json body --jq .body`);
  if (!result) return null;

  const match = result.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match ? match[1] : null;
}

export function getIssueInfo(issueNumber) {
  const title = exec(`gh issue view ${issueNumber} --json title --jq .title`);
  const body = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  return { title: title || '', body: body || '' };
}

export function getAcceptanceCriteria(issueNumber) {
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

// --- CI status check ---

export function getCiStatus(prNumber) {
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
