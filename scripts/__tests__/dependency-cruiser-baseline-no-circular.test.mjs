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

describe('dependency-cruiser baseline no-circular ratchet', () => {
  // Ratchet against baseline re-absorption: the baseline must never again absorb a
  // `no-circular` violation. A future `lint:deps` failure caused by a new
  // cycle must be fixed at the source, not silenced by re-running
  // `lint:deps:baseline` and committing the cycle into the known-violations
  // allowlist. This pin has no polarity against production code (there is
  // none to mutate) -- its reach is measured instead by temporarily
  // injecting a fake `no-circular` entry into the baseline file and
  // confirming the assertion fails, naming the offending entry.
  it('has no no-circular entries in the known-violations baseline', () => {
    const violations = readKnownViolations();
    const circularEntries = violations.filter((entry) => entry.rule?.name === 'no-circular');

    if (circularEntries.length > 0) {
      const offenders = circularEntries.map((entry) => `${entry.from} -> ${entry.to}`).join(', ');
      throw new Error(
        `Found ${circularEntries.length} no-circular entr${circularEntries.length === 1 ? 'y' : 'ies'} in ` +
          `.dependency-cruiser-known-violations.json: ${offenders}. Fix the cycle at the source instead of ` +
          `re-baselining it.`,
      );
    }

    expect(circularEntries).toEqual([]);
  });
});
