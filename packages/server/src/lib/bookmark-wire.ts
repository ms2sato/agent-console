import type { Bookmark } from '@agent-console/shared';
import type { BookmarkRecord } from '../repositories/bookmark-repository.js';

/**
 * Project a server-internal `BookmarkRecord` onto its wire `Bookmark`
 * shape by PICKING the five wire fields by name -- never a spread. A
 * spread-minus-denylist re-arms every time a new internal field is added
 * to `BookmarkRecord`: the next field leaks unless whoever adds it also
 * finds and updates every denylist site. A pick cannot leak an internal
 * field, because nothing carries a field across unless this function
 * names it.
 *
 * Single writer of "what a bookmark looks like on the wire" for server
 * responses -- mirrors `routes/artifacts.ts`'s field-by-field `Artifact`
 * reads, which never spread a record either.
 */
export function toWireBookmark(record: BookmarkRecord) {
  return {
    id: record.id,
    url: record.url,
    title: record.title,
    createdAt: record.createdAt,
    origin: record.origin,
  } satisfies Bookmark;
}

/**
 * Type-level pin: `toWireBookmark` is total in the safe direction. A wire
 * field added to `Bookmark` without a matching projection line above fails
 * `tsc` at the `_ToWireBookmarkIsTotal` declaration below with a `TS2344`
 * naming that symbol; an internal field added to `BookmarkRecord` is simply
 * never carried, guaranteed by construction (the function only ever names
 * wire keys, so it cannot "forget" to exclude a key it never named).
 *
 * The function deliberately has NO `: Bookmark` return-type annotation.
 * `satisfies Bookmark` on the returned object literal still guarantees
 * every caller that the shape is assignable to `Bookmark` (a missing or
 * mistyped field errors right there, at the return statement), but --
 * unlike an annotation -- it does not widen the expression's inferred type
 * to the nominal `Bookmark` type. That is what keeps `ReturnType<typeof
 * toWireBookmark>` reflecting the function's actual picked-key literal
 * shape instead of silently collapsing back to `Bookmark` itself, which
 * would make the `Equals` comparison below compare `keyof Bookmark` against
 * `keyof Bookmark` and pass unconditionally regardless of what the
 * function's body does. Per `.claude/rules/workflow.md`'s "pins include
 * type-level assertions" section, `declare const x: never` would be inert
 * here (no assignment for `never` to reject); this uses
 * `Assert<T extends true>` instead, mirroring the same idiom used in
 * `conflict-update-set.test.ts`, `notification.ts`, and
 * `embedded-agent-parameter-capabilities.ts`.
 *
 * Reach of this pin is measured and recorded in the sibling test file,
 * `__tests__/bookmark-wire.test.ts`.
 */
type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _ToWireBookmarkIsTotal = Assert<Equals<keyof ReturnType<typeof toWireBookmark>, keyof Bookmark>>;

export type { _ToWireBookmarkIsTotal };
