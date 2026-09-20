/**
 * Shared, PURE `/proc/<pid>/stat` parsing, imported by both the stdio-echo
 * fixture (which reads its own `/proc/self/stat` to record its starttime
 * in the spawn ledger) and the calling probe's teardown sweep (which
 * re-reads `/proc/<pid>/stat` to confirm a PID still belongs to the
 * process it originally spawned, before any `SIGKILL` -- Architect ruling
 * on PR #1782's CodeRabbit M2 finding: `process.kill(pid, 0)` alone cannot
 * distinguish a surviving fixture from an unrelated process that reused
 * the same PID after the fixture exited).
 *
 * Not a `scripts/smoke/*` entry point -- lives under `fixtures/` alongside
 * its only two consumers, has no `main()`, and does nothing on import.
 *
 * FORMAT (`man proc`, `/proc/[pid]/stat`): space-separated fields, where
 * field 2 (`comm`, the process name) is parenthesized and MAY ITSELF
 * CONTAIN spaces or parentheses -- so fields cannot be split on whitespace
 * from the start of the line. Splitting on the LAST `)` is the standard
 * safe approach (the kernel guarantees `comm` cannot contain `)` followed
 * by a space then more `)`-terminated content in a way that defeats this,
 * per the same manual page). Everything after that last `)` is fields 3
 * onward, space-separated: field 3 = state (index 0 of that split), ...,
 * field 22 = starttime (index 19).
 */
export function parseProcStatStarttime(statContent: string): string | null {
  const idx = statContent.lastIndexOf(')');
  if (idx === -1) return null;
  const rest = statContent
    .slice(idx + 1)
    .trim()
    .split(/\s+/);
  return rest[19] ?? null;
}
