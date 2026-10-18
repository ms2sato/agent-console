#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the file viewer's elevated read path
 * (`packages/server/src/services/file-viewer-service.ts`) and, with it,
 * `readWorkingTreeFile` in `packages/server/src/lib/git.ts`.
 *
 * Why it exists: the viewer lists and reads a directory that can be mode 0700
 * and owned by ANOTHER OS user, so every list / resolve / read runs through
 * `runAsUser`. Unit tests pin the command text and real-`sh` tests pin its
 * semantics, but neither crosses the elevated login shell, which re-parses the
 * inner command (`.claude/rules/elevation-helpers.md`), nor sends the
 * three-run `find -print0` output through the wrapper's pipes into the
 * double-NUL parser. This smoke does, against the SHIPPING code (no mocks):
 *
 *   1. As the server user, builds a `<target-user>`-owned mode-0700 directory
 *      THROUGH the elevated runner: a subdirectory, a dotfile, a symlink to a
 *      regular file inside, a symlink pointing outside, a fifo (`mkfifo`), a
 *      1 MiB + 1 byte file, a file with a NUL in its first 8 KiB, an empty file.
 *   2. Calls the real `listDirectory` / `readFileContent` with
 *      `requestUser = <target-user>` and asserts: the kind of every entry,
 *      directories first and byte-order names, the text content, `truncated`
 *      with the real size for the big file, `kind: 'binary'`, empty content,
 *      the symlink-out `ValidationError`, the fifo "not a regular file"
 *      `ValidationError` (promptly, not a blocked `cat`), and the missing-path
 *      `NotFoundError`. Failures print the actual value as evidence.
 *   3. Negative control, same run: the server process's own `readdir` and
 *      `readFile` on that directory fail with EACCES, so a pass is attributable
 *      to elevation and not to a directory the server could read anyway.
 *
 * Degenerate mode (`<target-user>` is the current user): `runAsUser` bypasses
 * elevation, so the cross-user boundary is NOT crossed and the negative control
 * is skipped (the directory is readable by construction). It still proves the
 * command text, the `sh -c` parsing of the three-run listing and the double-NUL
 * parse against real files, which the unit tests do not.
 *
 * Usage:   bun scripts/smoke/check-file-viewer-elevated-read.ts <target-user>
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (fixture could not be built, a phase timed out)
 */

import './_env.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import type { FileTreeEntry } from '../../packages/shared/src/index.js';
import { NotFoundError, ValidationError } from '../../packages/server/src/lib/errors.js';
import { runAsUser } from '../../packages/server/src/services/privilege-elevation.js';
import { listDirectory, readFileContent } from '../../packages/server/src/services/file-viewer-service.js';

const FIXTURE_TIMEOUT_MS = 60_000;
/** Whole-case bound: a stalled sudo / login shell must surface as exit 2, not a hang. */
const PHASE_GUARD_MS = 120_000;
const ONE_MIB = 1024 * 1024;

class ProbeTimeoutError extends Error {}

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: unknown): void => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    const shown = detail === undefined ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    console.error(`  FAIL  ${label}${shown}`);
    failures.push(label);
  }
};

/**
 * Entries `listDirectory` must return for the fixture root: directories first,
 * then plain byte-order names (`.` < lower-case letters; `pi` < `pl`).
 * @internal Exported for testing
 */
export const EXPECTED_ROOT_ENTRIES: FileTreeEntry[] = [
  { name: 'sub', kind: 'dir' },
  { name: '.hidden', kind: 'file' },
  { name: 'big.txt', kind: 'file' },
  { name: 'empty.txt', kind: 'file' },
  { name: 'link-in', kind: 'symlink' },
  { name: 'link-out', kind: 'symlink' },
  { name: 'nul.bin', kind: 'file' },
  { name: 'pipe', kind: 'file' },
  { name: 'plain.txt', kind: 'file' },
];

/**
 * The fixture, as a script for `sh -s` on stdin (never `command`: the elevated
 * login shell re-parses argv, which would expand `$` and collapse newlines).
 * `dir` is a path this smoke generated (letters, digits, dashes), so it is
 * safe unquoted inside single quotes.
 * @internal Exported for testing
 */
export function buildFixtureScript(dir: string): string {
  return [
    'set -e',
    `mkdir -m 700 '${dir}'`,
    `cd '${dir}'`,
    'mkdir sub',
    "printf 'nested\\n' > sub/inner.txt",
    "printf 'SECRET=1\\n' > .hidden",
    "printf 'hello\\n' > plain.txt",
    'ln -s plain.txt link-in',
    'ln -s /etc/passwd link-out',
    'mkfifo pipe',
    `head -c ${ONE_MIB + 1} /dev/zero | tr '\\000' a > big.txt`,
    "{ printf 'abc'; printf '\\000'; head -c 100 /dev/zero | tr '\\000' b; } > nul.bin",
    ': > empty.txt',
    '',
  ].join('\n');
}

async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(`${what} exceeded ${PHASE_GUARD_MS}ms`)), PHASE_GUARD_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The error a call threw, or undefined when it resolved. */
async function thrown(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function runAssertions(dir: string, user: string, degenerate: boolean): Promise<void> {
  console.log(`==> listDirectory root as '${user}' (elevated: ${!degenerate})`);
  const root = await listDirectory(dir, '', user);
  expect(
    JSON.stringify(root.entries) === JSON.stringify(EXPECTED_ROOT_ENTRIES),
    'root listing: kinds per entry, directories first, byte-order names, fifo as file, symlinks as symlink',
    { got: root.entries },
  );

  const sub = await listDirectory(dir, 'sub', user);
  expect(JSON.stringify(sub.entries) === JSON.stringify([{ name: 'inner.txt', kind: 'file' }]), 'subdirectory listing', sub.entries);

  const linkInDir = await thrown(() => listDirectory(dir, 'link-out', user));
  expect(
    linkInDir instanceof ValidationError,
    'tree request through the symlink that points outside is refused (ValidationError)',
    String(linkInDir),
  );

  console.log('==> readFileContent');
  const plain = await readFileContent(dir, 'plain.txt', user);
  expect(
    plain.kind === 'text' && plain.content === 'hello\n' && plain.size === 6 && !plain.truncated && plain.language === 'text',
    'text file: content, size, not truncated',
    plain,
  );
  const hidden = await readFileContent(dir, '.hidden', user);
  expect(hidden.content === 'SECRET=1\n', 'dotfile content is readable', hidden);

  const viaLink = await readFileContent(dir, 'link-in', user);
  expect(viaLink.content === 'hello\n', 'symlink to a regular file inside opens like its target', viaLink);

  const big = await readFileContent(dir, 'big.txt', user);
  expect(
    big.kind === 'text' && big.truncated === true && big.size === ONE_MIB + 1 && big.content?.length === ONE_MIB,
    '1 MiB + 1 byte: first 1 MiB, truncated, size is the real total',
    { kind: big.kind, truncated: big.truncated, size: big.size, contentLength: big.content?.length },
  );

  const bin = await readFileContent(dir, 'nul.bin', user);
  expect(bin.kind === 'binary' && bin.content === undefined && bin.size === 104, 'NUL in the first 8 KiB: kind binary, no content', bin);

  const empty = await readFileContent(dir, 'empty.txt', user);
  expect(empty.kind === 'text' && empty.content === '' && empty.size === 0 && !empty.truncated, 'empty file: content "", size 0', empty);

  const out = await thrown(() => readFileContent(dir, 'link-out', user));
  expect(
    out instanceof ValidationError && out.message === 'Path resolves outside the working directory',
    'symlink pointing outside: ValidationError, never content',
    String(out),
  );

  const fifoStarted = Date.now();
  const fifo = await bounded(
    thrown(() => readFileContent(dir, 'pipe', user)),
    'reading the fifo',
  );
  expect(
    fifo instanceof ValidationError && fifo.message === 'Not a regular file' && Date.now() - fifoStarted < 10_000,
    'fifo: "Not a regular file" ValidationError, promptly (no blocked cat)',
    { error: String(fifo), elapsedMs: Date.now() - fifoStarted },
  );

  const dirRead = await thrown(() => readFileContent(dir, 'sub', user));
  expect(dirRead instanceof ValidationError && dirRead.message === 'Path is a directory', 'directory on the content route: ValidationError', String(dirRead));

  const missing = await thrown(() => readFileContent(dir, 'nope.txt', user));
  expect(missing instanceof NotFoundError, 'missing file: NotFoundError (404 shape)', String(missing));

  const missingBehind = await thrown(() => readFileContent(dir, 'link-out/missing', user));
  expect(missingBehind instanceof NotFoundError, 'missing leaf behind a symlink that leaves the directory: NotFoundError, not an error', String(missingBehind));

  console.log('==> negative control: the server process itself cannot read the directory');
  if (degenerate) {
    console.log('  NOTE  degenerate same-user mode: the directory is readable by the server user, control skipped');
    return;
  }
  const direct = await thrown(() => readdir(dir));
  expect((direct as NodeJS.ErrnoException | undefined)?.code === 'EACCES', 'server readdir on the 0700 directory fails with EACCES', String(direct));
  const directRead = await thrown(() => readFile(`${dir}/plain.txt`));
  expect((directRead as NodeJS.ErrnoException | undefined)?.code === 'EACCES', 'server readFile inside the directory fails with EACCES', String(directRead));
}

async function main(): Promise<void> {
  process.chdir('/');

  const user = process.argv[2];
  if (!user) {
    console.error('usage: bun scripts/smoke/check-file-viewer-elevated-read.ts <target-user>');
    process.exit(2);
  }
  process.env.AUTH_MODE = 'multi-user';

  const degenerate = user === os.userInfo().username;
  if (degenerate) {
    console.warn(
      `  WARN  target user '${user}' equals the server-process user; elevation is bypassed (degenerate` +
        ' same-user mode). This still proves the command text, the sh parsing of the listing and the' +
        ' double-NUL parse against real files, but NOT the cross-user boundary or the EACCES control.',
    );
  }

  const dir = `/tmp/agent-console-fv-smoke-${randomUUID()}`;
  let timedOut = false;
  try {
    console.log(`==> building ${dir} as '${user}' through the elevated runner`);
    const built = await runAsUser({
      username: user,
      command: 'sh -s',
      stdin: buildFixtureScript(dir),
      cwd: '/',
      timeoutMs: FIXTURE_TIMEOUT_MS,
    });
    if (built.timedOut || built.exitCode !== 0) {
      console.error(`FIXTURE FAILED: exit ${built.exitCode} timedOut=${built.timedOut} stderr=${built.stderr}`);
      process.exitCode = 2;
      return;
    }
    await bounded(runAssertions(dir, user, degenerate), 'the assertions');
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      timedOut = true;
      console.error('PROBE TIMEOUT:', err.message);
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup (as the owner)');
    const cleaned = await runAsUser({
      username: user,
      command: `find '${dir}' -mindepth 1 -delete && rmdir '${dir}'`,
      cwd: '/',
      timeoutMs: FIXTURE_TIMEOUT_MS,
    }).catch((e: unknown) => ({ exitCode: -1, stderr: String(e), timedOut: false }));
    if (cleaned.exitCode !== 0) console.warn(`  cleanup: exit ${cleaned.exitCode} ${cleaned.stderr}`);
  }

  console.log();
  if (timedOut) {
    console.error('PROBE TIMED OUT (environment problem, not an assertion failure)');
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
}
