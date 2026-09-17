/**
 * Identity entry for the post-deploy verification's V3 (`mainpid_identity`
 * in scripts/lib/setup-multiuser-checks.sh):
 * compares the binary a running process executes (`/proc/<pid>/exe`) with a
 * configured `EMBEDDED_AGENT_BUN_PATH` value and prints ONE marker on
 * stdout. The comparison is the production `compareBinaryIdentity`
 * (packages/server/src/lib/embedded-agent-bun-path-check.ts) -- the same
 * function the server's boot-time WARN and the elevation smoke use -- so the
 * deploy script, the server and the smoke cannot drift on what "same binary"
 * means (single writer).
 *
 * Usage: `<bun> scripts/lib/embedded-agent-bun-identity.ts <pid|self-exe> <configured>`
 *
 *   <pid|self-exe>  a MainPID (digits), read as `/proc/<pid>/exe`; or an
 *                   absolute path used verbatim as the "self" side (e.g.
 *                   `/proc/self/exe`) -- the sibling test's seam, which needs
 *                   no fake `realpath` because real files carry every case
 *   <configured>    the EMBEDDED_AGENT_BUN_PATH value under test
 *
 * Markers (exit 0 in every case -- the MARKER is the answer, the exit code
 * only says whether an answer was produced):
 *   SAME                      both resolve to the identical file
 *   DIFFERENT                 both resolve, to different files
 *   UNRESOLVABLE:self         `/proc/<pid>/exe` could not be resolved -- with
 *                             the right uid+gid this is a real finding; with
 *                             the wrong gid it is the PTRACE_MODE_READ gap
 *                             (measured on the dogfood host), which is why
 *                             V3 runs this as the unit's User= AND Group=
 *   UNRESOLVABLE:configured   <configured> could not be resolved (ENOENT, or
 *                             EACCES on an ancestor directory)
 *   UNRESOLVABLE:bare         <configured> is a bare name, not an absolute
 *                             path (nothing a single realpath could compare)
 *
 * Bad usage (missing arguments) prints nothing on stdout and exits 2, so a
 * caller reading the marker sees "no marker", the cannot-run shape.
 *
 * Import-safe: the only top-level invocation is behind `import.meta.main`
 * (the smoke scripts' discipline, test-trigger.md "born import-safe"), so
 * the sibling test can import `markerFor` without running a comparison.
 */
import { realpath } from 'node:fs/promises';
import {
  compareBinaryIdentity,
  type BinaryIdentity,
} from '../../packages/server/src/lib/embedded-agent-bun-path-check.js';

/** Maps a `compareBinaryIdentity` result to the single stdout marker V3 reads. */
export function markerFor(identity: BinaryIdentity): string {
  if (typeof identity === 'string') {
    return identity === 'same' ? 'SAME' : 'DIFFERENT';
  }
  return `UNRESOLVABLE:${identity.unresolvable}`;
}

/** A MainPID (digits) becomes `/proc/<pid>/exe`; anything else is the self path verbatim. */
export function selfExeFor(pidOrPath: string): string {
  return /^[0-9]+$/.test(pidOrPath) ? `/proc/${pidOrPath}/exe` : pidOrPath;
}

/** Entry: prints the marker for `<pid|self-exe> <configured>` and returns the process exit code (2 on bad usage). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [pidOrPath, configured] = argv;
  if (!pidOrPath || !configured) {
    console.error('usage: embedded-agent-bun-identity.ts <pid|self-exe> <configured-bun-path>');
    return 2;
  }
  const identity = await compareBinaryIdentity(selfExeFor(pidOrPath), configured, { realpath });
  console.log(markerFor(identity));
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
