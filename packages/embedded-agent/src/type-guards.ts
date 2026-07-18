/**
 * Runtime type guards for values whose static type is `unknown` (typically a
 * `catch` binding) but that the caller expects to be errno-shaped.
 *
 * Mirrors `packages/server/src/lib/type-guards.ts`. Duplicated (rather than
 * imported) because `packages/server` depends on `@agent-console/embedded-agent`
 * (see `packages/server/package.json`), so the reverse import direction would
 * be circular. Promoting this to `@agent-console/shared` was considered instead,
 * but the `NodeJS.ErrnoException` return type would leak the `NodeJS` namespace
 * into `shared`'s `.d.ts`, which the client package also consumes — undesirable
 * for a type only meaningful on the Node/Bun side. If a third consumer needs
 * this guard, revisit promoting a structural variant (`err is { code?: string }`,
 * no `NodeJS` namespace dependency) to `shared` instead of duplicating again.
 */

/**
 * Structural check for Node's `ErrnoException` shape. Narrows `unknown` to
 * `NodeJS.ErrnoException` so callers can read `.code` (and other
 * `ErrnoException` fields such as `errno` / `syscall` / `path`) without an
 * unsafe cast.
 *
 * Accepts a non-null object whose `code` property is either absent
 * (`undefined`) or a `string` — matching the `code?: string` field on
 * `NodeJS.ErrnoException`. Rejects `null`, non-objects, and objects whose
 * `code` is present but not a string (e.g. `{ code: 123 }`), since those are
 * not errno-shaped.
 */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (typeof (err as { code: unknown }).code === 'string' || (err as { code: unknown }).code === undefined)
  );
}
