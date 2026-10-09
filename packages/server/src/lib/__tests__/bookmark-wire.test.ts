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
// (`_ToWireBookmarkIsTotal`).
//
// An earlier revision of `toWireBookmark` had an explicit `: Bookmark`
// return-type annotation. That made `ReturnType<typeof toWireBookmark>`
// resolve to the ANNOTATED type `Bookmark` itself (TypeScript uses the
// declared signature for `typeof` on a value, independent of whether the
// body satisfies it), so `Equals<keyof ReturnType<typeof toWireBookmark>,
// keyof Bookmark>` compared `keyof Bookmark` against `keyof Bookmark` and
// was tautologically `true` no matter what field was added -- the pin as
// written then had no detection power (measured: the `TS2741` diagnostic
// landed on the function's own `return { ... }` statement, never on
// `_ToWireBookmarkIsTotal` or `Assert`). That measurement was reported here
// per `.claude/rules/workflow.md`'s "a check's existence is not its
// detection power", and the fix below was made in response.
//
// FIX: the function now has no `: Bookmark` annotation; the returned object
// literal instead uses `satisfies Bookmark`, which checks assignability
// without widening the expression's inferred type. `ReturnType<typeof
// toWireBookmark>` now reflects the function's actual picked-key literal
// shape, so the `Equals` comparison is real.
//
// Re-measured with the fix in place. Adding a scratch field to the
// `Bookmark` interface (`packages/shared/src/types/bookmark.ts`) and running
// `bunx tsc --noEmit` from `packages/server` produces:
//
//   src/database/mappers.ts(869,3): error TS2741: Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string | null; createdAt: string; origin: "user" | "agent"; }' but required in type 'Bookmark'.
//   src/lib/__tests__/bookmark-wire.test.ts(7,7): error TS2741: Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string; createdAt: string; origin: "user"; userId: string; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//   src/lib/bookmark-wire.ts(24,5): error TS1360: Type '{ id: string; url: string; title: string | null; createdAt: string; origin: "agent" | "user"; }' does not satisfy the expected type 'Bookmark'.
//     Property 'extraScratchField' is missing in type '{ id: string; url: string; title: string | null; createdAt: string; origin: "agent" | "user"; }' but required in type 'Bookmark'.
//   src/lib/bookmark-wire.ts(58,38): error TS2344: Type 'false' does not satisfy the constraint 'true'.
//   src/repositories/__tests__/sqlite-bookmark-repository.test.ts(48,32): error TS2769: No overload matches this call.
//     Overload 1 of 2, '(expected: BookmarkRecord): void', gave the following error.
//       Argument of type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' is not assignable to parameter of type 'BookmarkRecord'.
//         Property 'extraScratchField' is missing in type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//     Overload 2 of 2, '(expected: NoInfer<BookmarkRecord>): void', gave the following error.
//       Argument of type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' is not assignable to parameter of type 'BookmarkRecord'.
//         Property 'extraScratchField' is missing in type '{ id: string; userId: string; url: string; title: string; createdAt: string; origin: "user"; sourceSessionId: string; }' but required in type 'BookmarkRecord'.
//
// The `TS2344` at `src/lib/bookmark-wire.ts(58,38)` is the
// `_ToWireBookmarkIsTotal` declaration (`Assert<Equals<...>>`'s type
// argument) -- confirmed by reading the file at that line/column. The pin
// now actually fires, in addition to the (expected, independent) `TS1360`
// at the `satisfies Bookmark` return statement itself.
//
// Reverse-direction check: adding a scratch field to `BookmarkRecord`
// (`packages/server/src/repositories/bookmark-repository.ts`) and running
// `bunx tsc --noEmit` produces `TS2741`/`TS2769` noise at the three places
// that construct a `BookmarkRecord` literal (`mappers.ts`, this test file's
// own fixture, `sqlite-bookmark-repository.test.ts`) -- and, confirmed by
// inspecting the output, ZERO diagnostics inside `bookmark-wire.ts` itself.
// This matches the JSDoc's claim: the function only ever reads the five
// named wire fields off `record`, so an unrelated internal field cannot
// affect its body or the pin.
//
// Both scratch fields were reverted immediately after capturing each
// diagnostic set, confirmed via `git diff --stat` showing no residual diff.
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
