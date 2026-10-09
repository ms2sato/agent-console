import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const KNOWN_VIOLATIONS_PATH = resolve(REPO_ROOT, '.dependency-cruiser-known-violations.json');
const CONFIG_PATH = resolve(REPO_ROOT, '.dependency-cruiser.cjs');

// The config (CJS) is the single writer of the rule name this ratchet guards.
// Load it with createRequire rather than restating the literal, so a rename
// or a severity downgrade in the config breaks this test loudly instead of
// the ratchet silently stopping ratcheting. See the two `it`s below for the
// positive controls this buys, and the comment above `assertNoCircular` for
// how `RULE` (derived here) threads through both existing tests.
const require = createRequire(import.meta.url);
const config = require(CONFIG_PATH);
const noCircularRule = config.forbidden?.find((rule) => rule.name === 'no-circular');
const RULE = noCircularRule?.name;

function readKnownViolations() {
  const raw = readFileSync(KNOWN_VIOLATIONS_PATH, 'utf8');
  return JSON.parse(raw);
}

// Ratchet against baseline re-absorption: the baseline must never again absorb a
// `no-circular` violation. A future `lint:deps` failure caused by a new cycle
// must be fixed at the source, not silenced by re-running `lint:deps:baseline`
// and committing the cycle into the known-violations allowlist.
//
// Extracted to a pure function so BOTH the clean-baseline path and the
// injected-fake-entry failure path are exercised on every run, not just
// described in a comment. The filter/throw logic living only inside the one
// test that also reads the real (currently clean) baseline file would mean:
// if the `entry.rule?.name === RULE` check ever broke silently (a refactor,
// a typo, a `rule.name` -> `rule.type` rename upstream), the test would stay
// green forever as long as the real baseline happened to still be empty of
// `no-circular` entries -- the ratchet's detection power would be
// unverified, not merely unexercised. The second test below constructs a
// synthetic violations array with a fake entry and asserts the function
// actually throws and names the offender, so the ratchet's failure path is
// asserted continuously rather than measured once by hand and written down.
//
// `RULE` is derived from the real .dependency-cruiser.cjs above, not
// restated as a literal -- this closes the gap this file's own ratchet had:
// renaming the rule in the config used to make this test keep looking for a
// name that no longer exists and pass forever (Issue #1542). The first `it`
// below pins that the config still defines a rule by that name and that it
// is still severity 'error'; both pins were reach-measured against this
// test file with scratch edits to .dependency-cruiser.cjs, reverted after
// each measurement (`git diff` confirmed empty both times):
//
// (1) Renamed the rule from 'no-circular' to 'no-cycles' in the config.
//     `bun test ./scripts/__tests__/dependency-cruiser-baseline-no-circular.test.mjs`
//     -> 1 fail: "the rule this ratchet guards still exists in the config,
//     with severity error" -- `expect(RULE).toBeDefined()` received
//     `undefined`. The other three tests still passed (RULE === undefined
//     makes `entry.rule?.name === undefined` false for every real entry, so
//     the clean-baseline test stayed green vacuously -- exactly the
//     disconnected-but-internally-consistent failure mode #1542 reported,
//     now caught by this pin instead of passing silently).
//
// (2) Downgraded the rule's severity from 'error' to 'warn' in the config
//     (name left as 'no-circular'). Same command -> 1 fail: same test name
//     -- `expect(noCircularRule?.severity).toBe('error')` received 'warn'.
//     The other three tests still passed, confirming this pin is the only
//     one that reaches a severity downgrade; without it, a downgrade would
//     let a cycle reach the baseline-free path without failing CI/`lint:deps`.
function assertNoCircular(violations) {
  const circularEntries = violations.filter((entry) => entry.rule?.name === RULE);

  if (circularEntries.length > 0) {
    const offenders = circularEntries.map((entry) => `${entry.from} -> ${entry.to}`).join(', ');
    throw new Error(
      `Found ${circularEntries.length} no-circular entr${circularEntries.length === 1 ? 'y' : 'ies'} in ` +
        `.dependency-cruiser-known-violations.json: ${offenders}. Fix the cycle at the source instead of ` +
        `re-baselining it.`,
    );
  }
}

describe('dependency-cruiser baseline no-circular ratchet', () => {
  it('the rule this ratchet guards still exists in the config, with severity error', () => {
    expect(Array.isArray(config.forbidden)).toBe(true);
    expect(RULE).toBeDefined();
    expect(noCircularRule?.severity).toBe('error');
  });

  it('has no no-circular entries in the known-violations baseline', () => {
    const violations = readKnownViolations();
    expect(() => assertNoCircular(violations)).not.toThrow();
  });

  it('fails when a no-circular entry is present (reach, executed not described)', () => {
    const withFakeEntry = [
      ...readKnownViolations(),
      {
        type: 'cycle',
        from: 'packages/client/src/components/FAKE-RATCHET-TEST-ENTRY.tsx',
        to: 'packages/client/src/components/FAKE-RATCHET-TEST-SIBLING.tsx',
        rule: { severity: 'error', name: RULE },
      },
    ];

    expect(() => assertNoCircular(withFakeEntry)).toThrow(/FAKE-RATCHET-TEST-ENTRY\.tsx -> .*FAKE-RATCHET-TEST-SIBLING\.tsx/);
  });
});
