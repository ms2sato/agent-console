import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Registry-style pin for Issue #1792: PR #1780 made
 * `CreateEmbeddedAgentRequestSchema` an `engine`-discriminated `v.variant`
 * (`packages/shared/src/schemas/embedded-agent.ts`), so a
 * `POST /api/embedded-agents` body missing `engine` now gets a 500
 * (`ValidationError: engine: Invalid type...`) instead of the 201 every
 * smoke fixture-creation call expects. Three smoke scripts hit exactly
 * this -- `check-embedded-agent-elevation.ts`, `check-embedded-agent-bash-
 * env.ts`, `check-webhook-issue-label-routing.ts` -- surfaced only when
 * PR #1789's tier-3 run reached step 9 weeks after #1780 landed, because
 * the tier-3 workflow is paths-filtered and #1780 touched none of its
 * paths.
 *
 * This pin closes that gap mechanically: for every ACTUAL create call site
 * (a `fetch(...)`/`new Request(...)` whose route argument is the create
 * route and whose options carry `method: 'POST'`), the call's own
 * `JSON.stringify(...)` argument must be an inline object literal
 * containing `engine: '` -- so the NEXT time this schema (or a sibling
 * shaped like it) tightens, the smoke that calls it fails in the ordinary
 * test suite, not in a tier-3 run weeks later.
 *
 * Scoped to the CALL SITE, not the whole file, per two flaws an Architect
 * review (and, independently, CodeRabbit on this same PR) found in an
 * earlier whole-file-text version of this pin:
 *   - FALSE PASS: a whole-file `engine: '` search is satisfied by a
 *     comment, a log message, or a type annotation anywhere in the file,
 *     none of which affect what the server actually receives.
 *   - FALSE NEGATIVE: requiring the literal `JSON.stringify({` misses a
 *     smoke that builds the body in a variable first (`const body = {...};
 *     ... JSON.stringify(body)`) -- a shape this pin cannot statically
 *     verify, so it must be REJECTED (a build-not-inline body is a hole
 *     this pin cannot close, not something to skip silently).
 *
 * Glob-driven (not a hardcoded file list), same convention as the sibling
 * `registry-reachability.test.ts`: a future smoke that creates an
 * embedded-agent definition is covered automatically.
 *
 * Three polarity mutations, each measured directly against this exact
 * implementation and restored after observing the failure:
 *   (a) delete the `engine: 'openai-api',` line from the elevation smoke's
 *       create body -> the corresponding per-call-site assertion fails
 *       (`engine: '` absent from the extracted object literal).
 *   (b) move that same line into a comment directly above the `fetch(`
 *       call, leaving the body without it -> still fails: the object
 *       literal extracted from the CALL's own `JSON.stringify({...})`
 *       argument does not include anything outside its balanced braces,
 *       so a preceding comment is invisible to the check (the false-PASS
 *       fix, specifically).
 *   (c) replace the elevation smoke's inline
 *       `JSON.stringify({ name: ..., engine: ..., provider: ... })` with a
 *       two-line `const body = { ... }; ... JSON.stringify(body)` (body
 *       content unchanged, including `engine`) -> fails with this pin's
 *       own "build the create body inline" message, not a false pass (the
 *       false-negative fix, specifically) -- proving the pin actively
 *       rejects a shape it cannot verify rather than silently ignoring it.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_DIR = path.join(REPO_ROOT, 'scripts/smoke');

// Matches the create route (`/api/embedded-agents`) but not an id-suffixed
// sub-route (`/api/embedded-agents/${id}`, `/api/embedded-agents/foo`):
// the negative lookahead rejects a route match immediately followed by
// another `/`.
const CREATE_ROUTE_PATTERN = /\/api\/embedded-agents(?!\/)/g;
const ENGINE_FIELD_PATTERN = /\bengine:\s*'/;

function discoverSmokeFiles(): string[] {
  const glob = new Glob('*.{ts,mjs}');
  return [...glob.scanSync({ cwd: SMOKE_DIR, onlyFiles: true })].sort();
}

/** Scans forward from `openParenIndex` (the position of an opening `(` or
 * `{`) for its balanced closing delimiter, returning that index (inclusive)
 * or -1 if the content ends unbalanced. Does not account for delimiters
 * inside string/template literals -- acceptable here because every real
 * call site's parens/braces in these files are structural, not embedded in
 * string content that itself contains `(`/`)`/`{`/`}`. */
function findBalancedEnd(content: string, openIndex: number, openChar: '(' | '{', closeChar: ')' | '}'): number {
  let depth = 1;
  for (let i = openIndex + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface CreateCallSite {
  /** The full text of the enclosing fetch(...)/new Request(...) call. */
  callText: string;
}

/** Finds every `fetch(...)`/`new Request(...)` call in `content` whose
 * route argument matches the create route pattern, returning one entry per
 * such call (NOT one per route-string mention -- a route mention with no
 * enclosing fetch/Request call, e.g. in a comment or a log message, yields
 * no entry at all). */
function findCreateCallSites(content: string): CreateCallSite[] {
  const sites: CreateCallSite[] = [];
  const seenCallStarts = new Set<number>();
  for (const match of content.matchAll(CREATE_ROUTE_PATTERN)) {
    const routeIndex = match.index;
    const before = content.slice(0, routeIndex);
    const fetchIdx = before.lastIndexOf('fetch(');
    const requestIdx = before.lastIndexOf('Request(');
    // The '(' immediately preceding the call's argument list, for whichever
    // of fetch(/Request( appears LAST before the route mention.
    let callParenIndex: number;
    if (fetchIdx === -1 && requestIdx === -1) continue;
    if (fetchIdx > requestIdx) {
      callParenIndex = fetchIdx + 'fetch'.length; // index of '('
    } else {
      callParenIndex = requestIdx + 'Request'.length; // index of '('
    }
    if (seenCallStarts.has(callParenIndex)) continue; // same call, another route mention inside it (not expected, but avoid double-counting)
    const callEnd = findBalancedEnd(content, callParenIndex, '(', ')');
    if (callEnd === -1) continue;
    seenCallStarts.add(callParenIndex);
    sites.push({ callText: content.slice(callParenIndex, callEnd + 1) });
  }
  return sites;
}

describe('scripts/smoke/* embedded-agent create calls carry `engine` (Issue #1792)', () => {
  const smokeFiles = discoverSmokeFiles();

  it('discovers a non-trivial number of smoke scripts (the discovery glob itself is not silently empty)', () => {
    expect(smokeFiles.length).toBeGreaterThanOrEqual(20);
  });

  const perFile = smokeFiles.map((file) => ({
    file,
    sites: findCreateCallSites(readFileSync(path.join(SMOKE_DIR, file), 'utf-8')),
  }));
  const candidates = perFile.filter(({ sites }) => sites.length > 0);

  it('finds at least the three smoke scripts known to create an embedded-agent definition (the filter itself is not silently empty)', () => {
    // Same "empty discovery masks every assertion below" shape as
    // registry-reachability.test.ts's own guards -- workflow.md
    // sub-pattern 9. Floor of 3, matching this Issue's own enumeration.
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const names = candidates.map((c) => c.file);
    expect(names).toContain('check-embedded-agent-elevation.ts');
    expect(names).toContain('check-embedded-agent-bash-env.ts');
    expect(names).toContain('check-webhook-issue-label-routing.ts');
  });

  const KNOWN_SINGLE_CREATE_CALL_FILES = [
    'check-embedded-agent-elevation.ts',
    'check-embedded-agent-bash-env.ts',
    'check-webhook-issue-label-routing.ts',
  ];

  for (const file of KNOWN_SINGLE_CREATE_CALL_FILES) {
    it(`${file} yields EXACTLY one create call site (proves non-call route mentions -- comments, log messages -- are excluded, not collapsed)`, () => {
      const entry = perFile.find((p) => p.file === file);
      expect(entry).toBeDefined();
      expect(entry!.sites.length).toBe(1);
    });
  }

  for (const { file, sites } of candidates) {
    for (const [i, site] of sites.entries()) {
      const label = sites.length > 1 ? `${file} (call ${i + 1})` : file;
      it(`${label}: the create call's own body carries \`engine: '\` inside its inline JSON.stringify object`, () => {
        // Not every fetch/Request call to this route is necessarily a
        // POST (a future GET/DELETE against a sibling route shape would
        // still match the route pattern) -- skip anything that is not.
        if (!/method:\s*'POST'/.test(site.callText)) {
          return;
        }
        const stringifyMatch = /JSON\.stringify\(/.exec(site.callText);
        expect(stringifyMatch).not.toBeNull();
        const afterParen = stringifyMatch!.index + stringifyMatch![0].length;
        // Skip whitespace to find the first real character of the argument.
        let firstCharIndex = afterParen;
        while (firstCharIndex < site.callText.length && /\s/.test(site.callText[firstCharIndex])) firstCharIndex++;
        const firstChar = site.callText[firstCharIndex];
        if (firstChar !== '{') {
          // The body is NOT an inline object literal (e.g. `JSON.stringify(body)`
          // with `body` built up separately) -- a shape this pin cannot
          // statically verify. Reject outright rather than silently
          // treating it as covered.
          throw new Error(
            `${label}: JSON.stringify's argument is not an inline object literal ('${firstChar}...') -- build the create body inline so this pin can read it`,
          );
        }
        const objEnd = findBalancedEnd(site.callText, firstCharIndex, '{', '}');
        expect(objEnd).toBeGreaterThan(-1);
        const objectLiteral = site.callText.slice(firstCharIndex, objEnd + 1);
        expect(ENGINE_FIELD_PATTERN.test(objectLiteral)).toBe(true);
      });
    }
  }
});
