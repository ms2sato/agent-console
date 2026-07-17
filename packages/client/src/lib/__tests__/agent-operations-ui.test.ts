import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_OPERATIONS } from '@agent-console/shared';
import { UI_AGENT_OPERATIONS } from '../agent-operations-ui';

const COMPONENTS_DIR = fileURLToPath(new URL('../../components', import.meta.url));

/** Coarse recursive existence check: does any file named `fileName` exist
 *  somewhere under packages/client/src/components? Intentionally loose
 *  (name match, not exact path) so a future directory move doesn't make
 *  this test fragile. */
function componentFileExists(fileName: string, dir: string = COMPONENTS_DIR): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (componentFileExists(fileName, `${dir}/${entry.name}`)) return true;
    } else if (entry.name === fileName) {
      return true;
    }
  }
  return false;
}

describe('UI_AGENT_OPERATIONS', () => {
  test('covers exactly the members of AGENT_OPERATIONS (no missing/extra)', () => {
    // Redundant with the `satisfies Record<AgentOperation, SurfaceExposure>`
    // compile-time gate on the production table -- this is a runtime
    // regression guard documenting the same intent.
    const actualKeys = Object.keys(UI_AGENT_OPERATIONS).sort();
    const expectedKeys = [...AGENT_OPERATIONS].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  test('all entries are currently exposed (matches the spec table)', () => {
    // NOTE: if this test starts failing because an entry became
    // `exposed: false`, that is likely an INTENTIONAL table update (a new
    // recorded not-exposed decision for the UI surface), not a bug. Update
    // this test's expectation to match the new table -- do not just delete
    // the assertion.
    for (const operation of AGENT_OPERATIONS) {
      expect(UI_AGENT_OPERATIONS[operation].exposed).toBe(true);
    }
  });

  test('exposed entries referencing a specific component file point at a file that actually exists', () => {
    // Cross-check for `via` claims that name a specific component file, so
    // a future rename doesn't silently leave a stale claim. Only checks
    // entries whose `via` string looks like a bare component name.
    const componentFileClaims: Partial<Record<keyof typeof UI_AGENT_OPERATIONS, string>> = {
      createSessionWithAgent: 'CreateWorktreeForm.tsx',
      addWorkerToSession: 'AddAgentWorkerMenu.tsx',
    };

    for (const [operation, fileName] of Object.entries(componentFileClaims)) {
      expect(UI_AGENT_OPERATIONS[operation as keyof typeof UI_AGENT_OPERATIONS].via).toContain(
        fileName.replace('.tsx', ''),
      );
      expect(componentFileExists(fileName)).toBe(true);
    }
  });
});
