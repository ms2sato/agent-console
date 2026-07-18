/**
 * Runtime type guards for values whose static type is `unknown` (typically a
 * `catch` binding) but that the caller expects to be errno-shaped.
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
