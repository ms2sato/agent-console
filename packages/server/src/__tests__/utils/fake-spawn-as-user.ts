import type { FileSink, Subprocess } from 'bun';
import type { SpawnAsUserResult } from '../../services/privilege-elevation.js';

/**
 * Subset of Bun's real `FileSink` shape that `spawnAsUser`'s callers consume
 * via `SpawnAsUserResult.stdin` (write / end / flush). Derived with `Pick`
 * from the real type (rather than hand-typed) so a bun-types bump that
 * changes `write`/`end`/`flush`'s signature fails at this fixture instead of
 * silently drifting from what `spawnAsUser` actually returns.
 */
export type FakeFileSink = Pick<FileSink, 'write' | 'end' | 'flush'>;

/**
 * Subset of Bun's real `Subprocess<'pipe','pipe','pipe'>` shape that
 * `SpawnAsUserResult.subprocess` callers actually consume. This is a
 * deliberate subset -- the real `Subprocess` also has `readable`, `stdio`,
 * `terminal`, `exitCode`, `signalCode`, `killed`, `ref`/`unref`, `send`,
 * `disconnect`, `resourceUsage`, none of which any fake in this codebase
 * needs to populate -- so `FakeSubprocess` can never fully satisfy
 * `Subprocess` and `toSpawnAsUserResult` below still needs one direct cast
 * at its boundary. `kill` is derived from the real member (not hand-typed)
 * for the same drift-safety reason as `FakeFileSink` above.
 *
 * `pid` is optional: two consumers under test (`conditional-wakeup-manager.ts`,
 * `interactive-process-manager.ts`) never read `.subprocess.pid` (grepped,
 * zero hits), while the embedded-agent activation path
 * (`embedded-agent-worker-service.ts`) logs it, so fakes exercising that path
 * populate it and fakes exercising the other two omit it.
 */
export interface FakeSubprocess {
  pid?: number;
  exited: Promise<number>;
  stdin: FakeFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: Subprocess<'pipe', 'pipe', 'pipe'>['kill'];
}

/**
 * Build a `SpawnAsUserResult` from a `FakeSubprocess`/`FakeFileSink` pair.
 * `FakeSubprocess` is a deliberate subset of the real `Subprocess` (see its
 * doc comment above), so it cannot structurally satisfy
 * `SpawnAsUserResult['subprocess']` on its own -- the single `as
 * SpawnAsUserResult` cast below bridges that subset gap. No `unknown`
 * intermediate: the two types still overlap enough (subprocess/stdin/elevated)
 * for TypeScript to accept a direct cast.
 */
export function toSpawnAsUserResult(fields: {
  subprocess: FakeSubprocess;
  stdin: FakeFileSink;
  elevated?: boolean;
}): SpawnAsUserResult {
  const result: Pick<SpawnAsUserResult, 'elevated'> & { subprocess: FakeSubprocess; stdin: FakeFileSink } = {
    subprocess: fields.subprocess,
    stdin: fields.stdin,
    elevated: fields.elevated ?? false,
  };
  return result as SpawnAsUserResult;
}
