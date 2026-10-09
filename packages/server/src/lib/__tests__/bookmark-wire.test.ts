import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { BookmarkSchema } from '@agent-console/shared';
import { toWireBookmark } from '../bookmark-wire.js';
import type { BookmarkRecord } from '../../repositories/bookmark-repository.js';

const RECORD: BookmarkRecord = {
  id: 'bookmark-1',
  url: 'https://example.com',
  title: 'Example',
  createdAt: '2026-01-01T00:00:00.000Z',
  origin: 'user',
  userId: 'user-1',
  sourceSessionId: 'session-1',
};

describe('toWireBookmark', () => {
  it('projects a full BookmarkRecord to exactly the five wire keys', () => {
    const result = toWireBookmark(RECORD);
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'id', 'origin', 'title', 'url']);
  });

  it('a server-internal field added to BookmarkRecord is never carried across, and the projection still satisfies the strict wire schema', () => {
    const widened = { ...RECORD, internalOnly: 'x' } as BookmarkRecord & { internalOnly: string };
    const result = toWireBookmark(widened);
    expect(Object.keys(result)).not.toContain('internalOnly');
    expect(v.safeParse(BookmarkSchema, result).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reach measurement for the type-level pin in `../bookmark-wire.ts`
// (`_ToWireBookmarkIsTotal`): adding a scratch field to the `Bookmark`
// interface (`packages/shared/src/types/bookmark.ts`) and running
// `bunx tsc --noEmit` from `packages/server` produces:
//
//   src/database/mappers.ts(869,3): error TS2741: Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string | null; createdAt: string; origin: "user" | "agent"; }' but required in type 'Bookmark'.
//   src/lib/__tests__/bookmark-wire.test.ts(7,7): error TS2741: Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string; createdAt: string; origin: "user"; userId: string; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//   src/lib/bookmark-wire.ts(18,3): error TS2741: Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string | null; createdAt: string; origin: "agent" | "user"; }' but required in type 'Bookmark'.
//   src/repositories/__tests__/sqlite-bookmark-repository.test.ts(48,32): error TS2769: No overload matches this call.
//     Overload 1 of 2, '(expected: BookmarkRecord): void', gave the following error.
//       Argument of type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' is not assignable to parameter of type 'BookmarkRecord'.
//         Property 'extraScratchField' is missing in type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//     Overload 2 of 2, '(expected: NoInfer<BookmarkRecord>): void', gave the following error.
//       Argument of type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' is not assignable to parameter of type 'BookmarkRecord'.
//         Property 'extraScratchField' is missing in type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//
// MEASURED CORRECTION to `../bookmark-wire.ts`'s own JSDoc on
// `_ToWireBookmarkIsTotal`: that pin does NOT fire (no TS2344 appears,
// nowhere does `_ToWireBookmarkIsTotal` or `Assert` appear in the output
// above). The actual catching diagnostic is the TS2741 at
// `src/lib/bookmark-wire.ts(18,3)`, i.e. the function's own
// `return { ... }` statement failing its explicit `: Bookmark` return-type
// annotation. Reason: `toWireBookmark` has an explicit return-type
// annotation, so `ReturnType<typeof toWireBookmark>` resolves to the
// annotated type `Bookmark` itself (TypeScript uses the declared signature
// for `typeof` on a value, independent of whether the body satisfies it) --
// so `Equals<keyof ReturnType<typeof toWireBookmark>, keyof Bookmark>` is
// comparing `keyof Bookmark` against `keyof Bookmark` and is tautologically
// `true` no matter what field is added. The `_ToWireBookmarkIsTotal` pin as
// written has no detection power for this mutation; the real protection
// comes from the ordinary return-type check on the function body, which
// would exist with or without the pin. Per
// `.claude/rules/workflow.md`'s "A check's existence is not its detection
// power", this was measured rather than assumed, and the gap is reported
// here rather than silently patched over.
//
// Reverted immediately after capturing the diagnostic.
//
// Polarity: replacing the pick in `toWireBookmark` with `return { ...record };`
// makes the mechanism test above fail (the `internalOnly` key survives into
// the projection) and also fails `routes/__tests__/bookmarks.test.ts`'s two
// wire-leak assertions on `userId` and `sourceSessionId`. It additionally
// (beyond what was asked) fails 5 of 7 tests in
// `packages/integration/src/bookmark-list-boundary.test.ts`: that suite's
// setup calls the real `createBookmark()` client function against the real
// `POST /api/bookmarks` route, and `createBookmark()`'s own `v.parse` against
// the strict `BookmarkSchema` throws `Invalid key: Expected never but
// received "userId"` on the leaked field -- so the integration boundary test
// is NOT isolated from this mechanism the way a read-only GET-list smoke
// would be; the original expectation that it "should stay green" was wrong
// and is corrected here. Reverted immediately after capturing the failure.
// ---------------------------------------------------------------------------
