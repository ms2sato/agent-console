/**
 * Shared utilities for preflight-check.js and acceptance-check.js
 *
 * Contains file categorization, test coverage detection, integration test
 * analysis, and package boundary analysis.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
  // Use gh pr diff equivalent for local mode to ensure parity with CI mode.
  // gh pr diff compares against the target branch, which is typically 'main'.
  // The equivalent git command is: git diff --name-only origin/main...HEAD
  // This ensures both local and CI modes produce the same file list.
  const baseBranch = process.env.BASE_BRANCH || 'origin/main';
  const result = exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (result === null) {
    console.error(`Error: Could not retrieve local git diff against ${baseBranch}.`);
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
  /^\.claude\/hooks\/.+\.sh$/,
];

// Source-file extensions considered for coverage analysis. `.sh` is included
// because `.claude/hooks/**/*.sh` participates in COVERAGE_PATTERNS; the
// matching test extension is `.mjs` (see expectedTestExt below).
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|sh)$/;

// Test-file naming pattern. `.mjs` is recognised so hook tests
// (e.g. `enforce-permissions.test.mjs`) are matched against their
// `.sh` source.
const TEST_NAME_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

function expectedTestExt(sourceExt) {
  if (sourceExt === '.tsx') return '.tsx';
  if (sourceExt === '.sh') return '.mjs';
  return '.ts';
}

// Files excluded from coverage requirements (no runtime logic to test)
const COVERAGE_EXCLUSIONS = [
  /^packages\/shared\/src\/types\/.+\.ts$/,
  // *-types.ts / *-types.tsx convention: files containing only type
  // definitions (interfaces / type aliases) with no runtime logic.
  // Testing them is not meaningful — the type system already enforces
  // their shape at consume sites.
  /-types\.tsx?$/,
];

export function isTestFile(filePath) {
  return filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/');
}

/**
 * Check whether a file's content consists only of re-export statements.
 * Pure function — operates on the content string, no filesystem access.
 *
 * Re-export-only files (e.g., `packages/shared/src/index.ts` that only
 * `export * from './foo'`) have no runtime logic to test. Their sibling
 * test would be tautological (PR #694 added one only to silence the
 * coverage rule). This helper detects that pattern so the rule can skip.
 *
 * Recognises:
 *   export * from '...';
 *   export * as Name from '...';
 *   export { A, B } from '...';
 *   export type { A } from '...';
 *   export type * from '...';
 *
 * Block comments and line comments are stripped before matching. Empty
 * files return false (not re-export-only — they need real coverage).
 */
export function isReExportOnlyContent(content) {
  // Strip block comments (/* ... */, including JSDoc), then line comments (// ...).
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments.replace(/\/\/[^\n]*/g, '');

  const trimmed = noLineComments.trim();
  if (trimmed.length === 0) return false;

  // Split into statements on `;`, normalising whitespace so multi-line exports collapse.
  const statements = trimmed
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0);

  // Each statement must be `export [type] (* [as Name] | { ... }) from '...'`.
  const reExportPattern = /^export\s+(type\s+)?(\*(\s+as\s+\w+)?|\{[^{}]*\})\s+from\s+['"][^'"]+['"]$/;

  return statements.every(stmt => reExportPattern.test(stmt));
}

/**
 * Filesystem wrapper around `isReExportOnlyContent`.
 * Returns false on read errors so an unreadable file falls through to the
 * normal coverage rule (safer default — surface the gap rather than hide it).
 */
export function isReExportOnlyFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return isReExportOnlyContent(content);
  } catch {
    return false;
  }
}

export function requiresTestCoverage(filePath) {
  if (isTestFile(filePath)) return false;
  if (COVERAGE_EXCLUSIONS.some(pattern => pattern.test(filePath))) return false;
  if (!COVERAGE_PATTERNS.some(pattern => pattern.test(filePath))) return false;
  // Skip re-export-only files: their sibling test would be tautological
  // (the type system already enforces re-export shape at consume sites).
  if (isReExportOnlyFile(filePath)) return false;
  return true;
}

export function findTestFiles(changedFiles) {
  const testFiles = [];
  const productionFiles = [];

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      testFiles.push(file);
    } else if (SOURCE_EXT_RE.test(file)) {
      productionFiles.push(file);
    }
  }

  const testCoverage = [];
  for (const prodFile of productionFiles) {
    const ext = prodFile.match(SOURCE_EXT_RE)[0];
    const baseName = prodFile.replace(SOURCE_EXT_RE, '');
    const dir = baseName.substring(0, baseName.lastIndexOf('/'));
    const fileName = baseName.substring(baseName.lastIndexOf('/') + 1);

    const hasTest = testFiles.some(tf => {
      if (!TEST_NAME_RE.test(tf)) return false;
      const tfDir = tf.substring(0, tf.lastIndexOf('/'));
      const tfFileName = tf.substring(tf.lastIndexOf('/') + 1);
      const tfBaseName = tfFileName.replace(TEST_NAME_RE, '');
      if (tfBaseName !== fileName) return false;
      return tfDir === dir || tfDir === dir + '/__tests__';
    });

    const needsCoverage = requiresTestCoverage(prodFile);
    const expectedTestPath = dir + '/__tests__/' + fileName + '.test' + expectedTestExt(ext);
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

// --- Proposed Behavior ---

export function getProposedBehavior(issueNumber) {
  const result = exec(`gh issue view ${issueNumber} --json body --jq .body`);
  if (!result) return [];

  const lines = result.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    // Detect "## Proposed Behavior" heading
    if (/^##\s+Proposed Behavior\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    // Exit section on next heading
    if (inSection && /^##\s+/.test(line)) {
      break;
    }
    if (!inSection) continue;

    // Parse list items: "- text", "- [ ] text", "- [x] text"
    const match = line.match(/^- (?:\[[ x]\]\s+)?(.+)/);
    if (match) {
      items.push(match[1].trim());
    }
  }

  return items;
}

/**
 * Extract meaningful keywords from a proposed behavior item.
 * Returns backtick-enclosed terms, uppercase abbreviations (2+ chars),
 * and camelCase/PascalCase identifiers.
 */
export function extractKeywords(text) {
  const keywords = [];

  // Backtick-enclosed terms (code references)
  const codeRefs = text.matchAll(/`([^`]+)`/g);
  for (const m of codeRefs) {
    keywords.push(m[1]);
  }

  // Remove backtick-enclosed terms for further processing
  const plain = text.replace(/`[^`]+`/g, '');

  // Uppercase abbreviations (2+ chars): UI, API, MCP, REST, WebSocket, etc.
  const abbrevs = plain.matchAll(/\b([A-Z][A-Z0-9]+)\b/g);
  for (const m of abbrevs) {
    keywords.push(m[1]);
  }

  // camelCase / PascalCase identifiers
  const camelCase = plain.matchAll(/\b([a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g);
  for (const m of camelCase) {
    keywords.push(m[1]);
  }

  return [...new Set(keywords)];
}

export function getPrDiff(prNumber) {
  return exec(`gh pr diff ${prNumber}`) || '';
}

/**
 * Check each proposed behavior item against the PR diff using keyword matching.
 * Returns an array of { item, keywords, matched, matchedKeywords }.
 */
export function checkProposedBehaviorCoverage(proposedItems, prDiff) {
  return proposedItems.map(item => {
    const keywords = extractKeywords(item);
    const matchedKeywords = keywords.filter(kw => prDiff.includes(kw));
    return {
      item,
      keywords,
      matched: matchedKeywords.length > 0,
      matchedKeywords,
    };
  });
}

// --- Public-artifact language check ---

/**
 * Run scripts/check-public-artifacts-language.mjs and return its result.
 *
 * The Bun script is the source of truth for the detection regex and the
 * file:line:col output format; this helper just spawns it so that
 * preflight-check.js and acceptance-check.js can share the same verdict
 * without duplicating the regex or the glob walk.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] absolute path to repo root
 * @returns {{exitCode: number, stdout: string, stderr: string}}
 */
export function runLanguageCheck({ repoRoot, binary = 'bun' } = {}) {
  const root = repoRoot || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const scriptPath = resolve(root, 'scripts/check-public-artifacts-language.mjs');
  const result = spawnSync(binary, [scriptPath], {
    cwd: root,
    encoding: 'utf-8',
  });
  // result.error is set when the binary itself cannot be spawned (e.g. bun
  // missing from PATH). We surface this as a distinct condition rather than
  // letting the consumer mistake an empty stdout for "0 violations".
  if (result.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Failed to spawn '${binary}': ${result.error.message}`,
      spawnFailed: true,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnFailed: false,
  };
}

// --- CI status check ---

export function getCiStatus(prNumber) {
  const result = exec(`gh pr checks ${prNumber} --json name,state,bucket 2>/dev/null`);
  if (!result) return null;
  try {
    const checks = JSON.parse(result);
    const failed = checks.filter(c => c.bucket === 'fail');
    const pending = checks.filter(c => c.bucket === 'pending');
    const passed = checks.filter(c => c.bucket === 'pass');
    return { checks, failed, pending, passed, allGreen: failed.length === 0 && pending.length === 0 };
  } catch {
    return null;
  }
}
