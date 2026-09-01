import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const KNOWN_VIOLATIONS_PATH = resolve(REPO_ROOT, '.dependency-cruiser-known-violations.json');

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
// if the `entry.rule?.name === 'no-circular'` check ever broke silently (a
// refactor, a typo, a `rule.name` -> `rule.type` rename upstream), the test
// would stay green forever as long as the real baseline happened to still be
// empty of `no-circular` entries -- the ratchet's detection power would be
// unverified, not merely unexercised. The second test below constructs a
// synthetic violations array with a fake entry and asserts the function
// actually throws and names the offender, so the ratchet's failure path is
// asserted continuously rather than measured once by hand and written down.
function assertNoCircular(violations) {
  const circularEntries = violations.filter((entry) => entry.rule?.name === 'no-circular');

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
        rule: { severity: 'error', name: 'no-circular' },
      },
    ];

    expect(() => assertNoCircular(withFakeEntry)).toThrow(/FAKE-RATCHET-TEST-ENTRY\.tsx -> .*FAKE-RATCHET-TEST-SIBLING\.tsx/);
  });
});
