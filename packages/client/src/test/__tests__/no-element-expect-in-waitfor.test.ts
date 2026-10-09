import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Mechanical net for Issue #1899 ("closing a non-active worker tab while the
 * active agent tab mounts the real terminal store runs a multi-second
 * synchronous microtask/allocation loop"). Root cause (measured, bun 1.3.14 +
 * happy-dom 20.0.11): `expect(el).toBeNull()` inside a FAILING `waitFor` poll
 * is extremely slow, because bun:test's failure-message construction
 * serializes the happy-dom element -- not because the query itself is slow.
 * See `../waitForAbsent.ts`'s header and Issue #1899's body for the full
 * measurement ledger.
 *
 * This net scans every client test file's source TEXT (not an AST -- no
 * TypeScript parser dependency is pulled in for this) for a `waitFor(...)`
 * call whose callback body contains `expect(<a DOM query>)` followed
 * (possibly across lines) by `.toBeNull()`, where `<a DOM query>` is one of
 * `screen.queryBy*`, `document.querySelector`, or `container.querySelector`.
 * A match means a future failing poll will pay the same serialization cost
 * this Issue measured. The fix is `waitForAbsent(() => query())` from
 * `../waitForAbsent.ts` (or a boolean comparison / throw-based check).
 *
 * Per `workflow.md`'s "a check's existence is not its detection power", the
 * detector's own reach is pinned against an inline positive-control fixture
 * string below, not just asserted clean against the real tree.
 */

const QUERY_PREFIX_RE = /^(screen\.queryBy\w+|document\.querySelector|container\.querySelector)\s*\(/;

export interface WaitForAbsentViolation {
  line: number;
  snippet: string;
}

/**
 * Finds the index of the character matching `s[openIndex]` (expected to be
 * `openChar`), tracking string literals (single/double/template, with
 * backslash-escape handling) so a `)` or `}` inside a quoted argument (e.g.
 * `queryByPlaceholderText('e.g. opus)')`) never miscounts the balance.
 */
function findMatchingClose(s: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') {
        i++; // skip escaped character
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === openChar) {
      depth++;
    } else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Scans a single `waitFor(...)` call's argument text (already extracted,
 * between its outer parens) for an `expect(<DOM query>).toBeNull()` shape.
 * `blockStart` is the index of the first character of `block` within the
 * ORIGINAL `content` string, so reported line numbers point at the real
 * file location rather than an offset into the extracted substring.
 */
function findViolationsInBlock(content: string, block: string, blockStart: number): WaitForAbsentViolation[] {
  const violations: WaitForAbsentViolation[] = [];
  const expectRe = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = expectRe.exec(block))) {
    const openParenIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(block, openParenIdx, '(', ')');
    if (closeIdx === -1) continue;
    const inner = block.slice(openParenIdx + 1, closeIdx).trim();
    if (QUERY_PREFIX_RE.test(inner)) {
      const after = block.slice(closeIdx + 1);
      if (/^\s*\.toBeNull\(\)/.test(after)) {
        const absoluteIdx = blockStart + m.index;
        violations.push({
          line: lineOf(content, absoluteIdx),
          snippet: content.slice(absoluteIdx, absoluteIdx + 100).replace(/\s+/g, ' ').trim(),
        });
      }
    }
    expectRe.lastIndex = closeIdx + 1;
  }
  return violations;
}

/**
 * Scans a whole test file's source text for `waitFor(...)` calls and checks
 * each one's body via {@link findViolationsInBlock}.
 */
export function findWaitForAbsentViolations(content: string): WaitForAbsentViolation[] {
  const violations: WaitForAbsentViolation[] = [];
  let searchIdx = 0;
  while (true) {
    const idx = content.indexOf('waitFor', searchIdx);
    if (idx === -1) break;
    const before = idx > 0 ? content[idx - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(before)) {
      searchIdx = idx + 'waitFor'.length;
      continue;
    }
    let j = idx + 'waitFor'.length;
    while (j < content.length && /\s/.test(content[j])) j++;
    if (content[j] !== '(') {
      searchIdx = idx + 'waitFor'.length;
      continue;
    }
    const closeIdx = findMatchingClose(content, j, '(', ')');
    if (closeIdx === -1) {
      searchIdx = idx + 'waitFor'.length;
      continue;
    }
    const blockStart = j + 1;
    const block = content.slice(blockStart, closeIdx);
    violations.push(...findViolationsInBlock(content, block, blockStart));
    searchIdx = closeIdx + 1;
  }
  return violations;
}

describe('no `expect(domElement).toBeNull()` inside a waitFor poll (Issue #1899)', () => {
  it("detects the pattern in a positive-control fixture (the detector's own reach is pinned, not assumed)", () => {
    const fixture = [
      "await waitFor(() => {",
      "  expect(screen.queryByText('x')).toBeNull();",
      "});",
    ].join('\n');

    const violations = findWaitForAbsentViolations(fixture);
    expect(violations.length).toBe(1);
    expect(violations[0]!.snippet).toContain("expect(screen.queryByText('x')).toBeNull()");
  });

  it('does not flag the fixed shape (a boolean/throw-based check via waitForAbsent)', () => {
    const fixture = [
      "await waitForAbsent(() => screen.queryByText('x'));",
      "await waitFor(() => {",
      "  if (query() !== null) throw new Error('element still present');",
      "});",
    ].join('\n');

    expect(findWaitForAbsentViolations(fixture)).toEqual([]);
  });

  it('does not flag a plain (unpolled) expect(...).toBeNull() outside any waitFor', () => {
    const fixture = "expect(screen.queryByText('x')).toBeNull();";
    expect(findWaitForAbsentViolations(fixture)).toEqual([]);
  });

  it('finds zero violations across the real client test source tree', async () => {
    const srcDir = path.resolve(import.meta.dir, '../..');
    const glob = new Glob('**/*.test.{ts,tsx}');
    // This net's own file is excluded: it carries the positive-control
    // fixture string pinned in the test above, which is a deliberate
    // text-level match for this scanner (it is a string literal, not real
    // test code) and would otherwise flag itself on every run.
    const selfPath = path.relative(srcDir, import.meta.path);

    const allViolations: Array<{ file: string; violation: WaitForAbsentViolation }> = [];
    let filesScanned = 0;
    for await (const file of glob.scan(srcDir)) {
      if (file === selfPath) continue;
      filesScanned++;
      const absolutePath = path.join(srcDir, file);
      const content = readFileSync(absolutePath, 'utf8');
      for (const violation of findWaitForAbsentViolations(content)) {
        allViolations.push({ file, violation });
      }
    }

    // An empty scan would make the assertion below vacuously true --
    // workflow.md sub-pattern 9 ("an empty result read as an empty world").
    expect(filesScanned).toBeGreaterThan(50);

    if (allViolations.length > 0) {
      const report = allViolations
        .map(({ file, violation }) => `  ${file}:${violation.line}  ${violation.snippet}`)
        .join('\n');
      throw new Error(
        `Found ${allViolations.length} expect(<DOM query>).toBeNull() inside a waitFor poll. ` +
          `Replace with waitForAbsent(() => query()) from packages/client/src/test/waitForAbsent.ts ` +
          `(see Issue #1899 for the measured cost):\n${report}`,
      );
    }
  });
});
