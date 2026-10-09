/**
 * Build a Kysely `doUpdateSet` object from an insert row, excluding an
 * explicit immutable-columns list.
 *
 * ## The defect this exists to close
 *
 * A hand-maintained `doUpdateSet({ ... })` object is a second, independent
 * derivation of "which columns this row has" -- maintained separately from
 * the mapper that builds the INSERT side (`.values(row)`). A column present
 * on the row but missing from the hand-written update object fails
 * SILENTLY and ASYMMETRICALLY: the first INSERT writes the correct value,
 * and every subsequent write skips that column, pinning it forever at its
 * first-insert value. Nothing fails -- no type error, no runtime error, no
 * failing test. The row keeps updating (other columns change), so the
 * record looks alive while one field is frozen.
 *
 * `conflictUpdateSet` inverts the derivation: instead of listing columns to
 * WRITE, the caller lists columns to EXCLUDE (immutable columns -- `id`,
 * `created_at`, and anything else that must never change after insert). The
 * update object is built from the row itself, so a new mutable column is
 * written automatically the moment a mapper starts setting it on the row --
 * there is no second list to remember to update.
 *
 * ## Totality is the contract, and it is type-enforced at the call site
 *
 * `Row` must be `Required<Insertable<XTable>>`-shaped (e.g. `WorkerRowFull`
 * in `../database/schema.ts`) -- no optional keys, every column explicit.
 * This matters because Kysely's `doUpdateSet` treats a key whose value is
 * `undefined` as "omit this column from the SQL SET clause" (different from
 * `null`, which DOES reset the column). Before this helper existed, the
 * workers upsert carried exactly this problem and worked around it with a
 * hand-written `?? null` / `?? 1` fallback at the call site:
 *
 * > toWorkerRow's per-type branches omit these five keys entirely for types
 * > that don't declare them (e.g. 'agent' never sets
 * > sdk_session_id/auto_compaction/context_window_tokens; 'terminal' and
 * > 'git-diff' set none of the five), so workerRow.<key> is `undefined`
 * > rather than `null` on those branches. Kysely's doUpdateSet treats
 * > `undefined` as "omit this column from the SQL SET clause", which is
 * > different from `null` (which DOES reset the column) -- without the
 * > `?? null`/`?? 1` fallback below, a same-id restart into a type that
 * > doesn't declare one of these columns would silently leave the PREVIOUS
 * > type's stale value in place instead of resetting it.
 * >   -- `sqlite-session-repository.ts`, before this refactor
 *
 * That fallback now lives in the mapper (`toWorkerRow`'s per-type branches
 * set all 16 `workers` columns explicitly, never omitting one), not at the
 * call site: a `Row` typed as `Required<Insertable<XTable>>` makes an
 * omitted branch a COMPILE ERROR instead of a silent `undefined` -- see
 * `conflict-update-set.test.ts`'s type-level pin for the measured proof.
 *
 * @param row - A fully-populated insert row (every column explicit).
 * @param immutable - Columns to exclude from the update set (never written
 *   back on conflict).
 * @returns An object containing every key of `row` except `immutable`,
 *   suitable for
 *   `.onConflict((oc) => oc.column(...).doUpdateSet(conflictUpdateSet(row, [...])))`.
 */
export function conflictUpdateSet<Row extends object, const K extends readonly (keyof Row)[]>(
  row: Row,
  immutable: K
): { [C in Exclude<keyof Row, K[number]>]: Row[C] } {
  const immutableSet = new Set<keyof Row>(immutable);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row) as (keyof Row)[]) {
    if (!immutableSet.has(key)) {
      result[key as string] = row[key];
    }
  }
  return result as { [C in Exclude<keyof Row, K[number]>]: Row[C] };
}
