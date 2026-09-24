import { describe, it, expect } from 'bun:test';
// Importing this module installs the memfs `fs` / `node:fs` / `fs/promises` /
// `node:fs/promises` mocks (mock.module is process-global and permanent for
// the life of this test process).
//
// Polarity measured 2026-09-24: with the helper's mock factories reverted to
// `() => fs` / `() => fs.promises` (dropping the `default` property), both
// cases below throw `SyntaxError: Missing 'default' export in module
// 'node:fs'` -- 0 pass / 2 fail. With the fix in place, both pass.
import '../mock-fs-helper.js';

describe('mock-fs-helper module mock shape', () => {
  it('lets a module whose import graph reaches a default-importer of node:fs resolve', async () => {
    // routes/system.ts -> `open` -> is-wsl / is-docker / is-inside-container,
    // which do `import fs from 'node:fs'` (an ESM default import). This is
    // the exact module the bisection in the linked defect report isolated:
    // with the mocks installed and no `default` on the mocked module, this
    // import throws `SyntaxError: Missing 'default' export in module
    // 'node:fs'` instead of resolving.
    const mod = await import('../../../routes/system.js');

    expect(mod).toBeDefined();
  });

  it('pins the default-import shape independently of which dependency uses it today', async () => {
    // A dedicated fixture (imported nowhere else) isolates the shape from
    // any particular dependency's import graph: a plain ESM default import
    // of node:fs must resolve to an object with the real fs methods,
    // regardless of which library happens to do this today.
    const mod = await import('./fixtures/default-fs-import.js');

    expect(mod.ok).toBe(true);
  });
});
