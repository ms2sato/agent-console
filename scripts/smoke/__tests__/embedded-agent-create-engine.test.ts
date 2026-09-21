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
 * route and whose options carry a `method:` classified as an explicit
 * `'POST'`/`"POST"` string literal), the call's own `JSON.stringify(...)`
 * argument must be an inline object literal containing `engine: '` -- so
 * the NEXT time this schema (or a sibling shaped like it) tightens, the
 * smoke that calls it fails in the ordinary test suite, not in a tier-3
 * run weeks later.
 *
 * Scoped to the CALL SITE, not the whole file, per flaws an Architect
 * review (and, independently, CodeRabbit on this same PR, across two
 * review passes) found in earlier versions of this pin:
 *   - FALSE PASS (whole-file version): a whole-file `engine: '` search is
 *     satisfied by a comment, a log message, or a type annotation anywhere
 *     in the file, none of which affect what the server actually receives.
 *   - FALSE NEGATIVE (whole-file version): requiring the literal
 *     `JSON.stringify({` misses a smoke that builds the body in a variable
 *     first (`const body = {...}; ... JSON.stringify(body)`) -- a shape
 *     this pin cannot statically verify, so it must be REJECTED (a
 *     build-not-inline body is a hole this pin cannot close, not something
 *     to skip silently).
 *   - MISATTRIBUTION (call-site version, round 1): `findCreateCallSites`
 *     attributed a route mention to the nearest PRECEDING `fetch(`/
 *     `Request(` text without checking that the mention actually falls
 *     INSIDE that call's own balanced range. A route literal reused later
 *     in the file (e.g. inside a log/bail message quoting the route for a
 *     human-readable error) would be wrongly attributed to an earlier,
 *     already-closed call. Fixed by rejecting any route match whose index
 *     lies past the attributed call's balanced closing paren.
 *   - FAIL-OPEN METHOD CHECK (call-site version, round 1): the method
 *     gate required the EXACT text `method: 'POST'` (single quotes, no
 *     other spelling), so `method: "POST"` (double quotes), a computed
 *     value, or any other spelling of POST silently fell through the
 *     `return` (treated as "not a POST, nothing to check") instead of
 *     being flagged as unclassifiable. Fixed by classifying the method
 *     literal explicitly: an explicit `'POST'`/`"POST"` string literal is
 *     checked; an explicit non-POST literal (`'GET'`/`'DELETE'`/`'PATCH'`/
 *     `'PUT'`, either quote) is skipped (a real, different HTTP verb, nothing
 *     to check); anything else -- no `method:` key at all, or a non-literal
 *     value (a constant, a variable, a template expression) -- FAILS
 *     closed with an explicit "method could not be classified" error, the
 *     same fail-closed shape as the inline-body rule above.
 *
 * Glob-driven (not a hardcoded file list), same convention as the sibling
 * `registry-reachability.test.ts`: a future smoke that creates an
 * embedded-agent definition is covered automatically.
 *
 * Five polarity mutations, each measured directly against this exact
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
 *   (d) change the elevation smoke's `method: 'POST'` to `method: "POST"`
 *       (double quotes, body otherwise unchanged) -> the assertion still
 *       runs and still passes -- proving the method classification is not
 *       tied to one quote style (the fail-open fix's positive side).
 *   (e) change the elevation smoke's `method: 'POST'` to `method:
 *       someConst` (an unresolvable identifier) -> fails with this pin's
 *       "method could not be classified" message rather than silently
 *       skipping the call (the fail-open fix's negative side).
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SMOKE_DIR = path.join(REPO_ROOT, 'scripts/smoke');

// Matches the create route (`/api/embedded-agents`) but not an id-suffixed
// sub-route (`/api/embedded-agents/${id}`, `/api/embedded-agents/foo`):
// the negative lookahead rejects a route match immediately followed by
// another `/`.
const CREATE_ROUTE_PATTERN = /\/api\/embedded-agents(?!\/)/g;
const ENGINE_FIELD_PATTERN = /\bengine:\s*'/;

// An explicit `method:` string literal, either quote style.
const POST_LITERAL_PATTERN = /\bmethod:\s*(['"])POST\1/;
const NON_POST_LITERAL_PATTERN = /\bmethod:\s*(['"])(?:GET|DELETE|PATCH|PUT)\1/;

type MethodClassification = 'post' | 'skip' | 'unclassified';

/** Classifies a call's `method:` option from its balanced call text.
 * `'post'`: an explicit `'POST'`/`"POST"` literal -- this IS a create call,
 * check it. `'skip'`: an explicit non-POST literal (a real, different HTTP
 * verb) -- not a create call, nothing to check. `'unclassified'`: no
 * `method:` key at all, or a `method:` value that is not a recognized
 * string literal (a constant, a variable, a template expression) -- FAIL
 * CLOSED rather than silently treating an unreadable method as "not a
 * POST"; a shorthand or a differently-spelled literal must not bypass the
 * `engine` assertion below. */
function classifyMethod(callText: string): MethodClassification {
  if (POST_LITERAL_PATTERN.test(callText)) return 'post';
  if (NON_POST_LITERAL_PATTERN.test(callText)) return 'skip';
  return 'unclassified';
}

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
    const callEnd = findBalancedEnd(content, callParenIndex, '(', ')');
    if (callEnd === -1) continue;
    // The route mention must lie INSIDE the call it was attributed to.
    // `lastIndexOf` finds the nearest PRECEDING `fetch(`/`Request(` text,
    // but that call may already have closed before this route mention --
    // e.g. a route literal reused later in a log/bail message quoting the
    // route for a human-readable error. Attributing that mention to the
    // earlier, already-closed call would be wrong regardless of whether
    // the call site was already recorded, so reject it before the
    // dedup check rather than relying on dedup to hide the mistake.
    if (routeIndex > callEnd) continue;
    if (seenCallStarts.has(callParenIndex)) continue; // same call, another route mention inside it (not expected, but avoid double-counting)
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
        // still match the route pattern) -- skip anything explicitly
        // classified as a different verb, but fail closed on anything
        // this pin cannot read (see `classifyMethod`'s own doc comment).
        const methodClassification = classifyMethod(site.callText);
        if (methodClassification === 'skip') {
          return;
        }
        if (methodClassification === 'unclassified') {
          throw new Error(`${label}: method could not be classified -- write it as a string literal`);
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
