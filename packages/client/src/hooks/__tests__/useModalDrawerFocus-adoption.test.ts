import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

/**
 * Single-writer gate for the modal-drawer focus boundary: both mobile
 * drawers (`MobileSidebarDrawer`, `SessionSidePanelsDrawer`) must adopt
 * `useModalDrawerFocus` exactly once each, and must not carry their own
 * copy of any of the four effects the hook now owns (Escape-to-close, body
 * scroll lock, focus save/restore, Tab trap). A new local
 * `document.addEventListener('keydown', ...)` / `savedFocusRef` /
 * `document.body.style.overflow` in either drawer is a regression back
 * into the byte-alike duplication `useModalDrawerFocus` was introduced to
 * remove -- this test is the mechanical grep that catches it.
 *
 * Modeled on
 * `packages/server/src/database/__tests__/orchestrator-session-id-deadness.test.ts`:
 * uses `Bun.file()` + `path.resolve(import.meta.dir, ...)` rather than
 * `node:fs`, since a sibling test file in the same process may have
 * process-globally swapped `node:fs` for an in-memory volume.
 */

const DRAWER_FILES = [
  path.resolve(import.meta.dir, '../../components/sidebar/MobileSidebarDrawer.tsx'),
  path.resolve(import.meta.dir, '../../components/sessions/SessionSidePanelsDrawer.tsx'),
];

const FORBIDDEN_SNIPPETS = ["document.addEventListener('keydown'", 'savedFocusRef', 'document.body.style.overflow'];

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

describe('useModalDrawerFocus adoption (single-writer gate)', () => {
  for (const filePath of DRAWER_FILES) {
    const fileName = path.basename(filePath);

    it(`${fileName} calls useModalDrawerFocus exactly once`, async () => {
      // Reach (measured): removing the `useModalDrawerFocus(` call from the
      // drawer (adding its own local effects instead) fails this test
      // (count 0). Calling it twice also fails (count 2).
      const content = await Bun.file(filePath).text();
      expect(countOccurrences(content, 'useModalDrawerFocus(')).toBe(1);
    });

    it(`${fileName} does not carry its own copy of the effects the hook owns`, async () => {
      // Reach (measured): reintroducing any one of the three forbidden
      // snippets (e.g. a local Escape-to-close listener) into the drawer
      // fails this test.
      const content = await Bun.file(filePath).text();
      const offending = FORBIDDEN_SNIPPETS.filter((snippet) => content.includes(snippet));
      expect(offending).toEqual([]);
    });
  }
});
