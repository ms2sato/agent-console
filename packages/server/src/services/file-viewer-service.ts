/**
 * Read-only view of a session's working directory for the file viewer worker
 * (docs/design/file-viewer-worker.md): one directory level at a time, and the
 * content of one file, both as the session owner.
 *
 * Two modes, chosen by `requestUser` (the session's spawn user):
 * - `null`: in-process `fs` (single-user mode).
 * - a username: shell commands through `runAsUser`, because in multi-user mode
 *   the working directory can be mode 0700 for another OS user. `runAsUser`
 *   itself bypasses elevation when the user is the server user or
 *   `AUTH_MODE` is not multi-user, running the same command locally.
 *
 * Every shell command addresses its target by ABSOLUTE path, built from the
 * containment-checked real path. None relies on the wrapper's `cd <cwd>`: the
 * inner command must stay correct even if that `cd` did not take effect.
 *
 * Containment: the lexical guard (`isValidFilePath`) does not stop a symlink
 * inside the directory from pointing outside it, and the listing filters
 * nothing, so every request resolves the target's real path (as the session
 * owner, in the same mode as the read) and refuses one outside the real
 * working directory BEFORE the read or the listing uses the path. Only
 * existing paths are viewed, so a missing target is simply "not found": the
 * walk-up to the nearest existing ancestor that a write target needs has
 * nothing to decide here. The check and the read are separate calls, so a
 * symlink swapped in between is not caught -- the same window the embedded
 * agent's confinement has.
 */

import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import {
  prismLanguageForPath,
  UNKNOWN_PRISM_LANGUAGE,
  type FileContentResponse,
  type FileTreeEntry,
  type FileTreeResponse,
} from '@agent-console/shared';
import { readWorkingTreeFile } from '../lib/git.js';
import { InternalError, NotFoundError, ValidationError } from '../lib/errors.js';
import { isErrnoException } from '../lib/type-guards.js';
import { isValidFilePath } from '../lib/relative-file-path.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import {
  runAsUser,
  shellEscape,
  type RunAsUserOpts,
  type RunAsUserResult,
} from './privilege-elevation.js';

const logger = createLogger('file-viewer-service');

/** Bytes inspected for a NUL to classify a file as binary (git's own window). */
export const FILE_VIEWER_BINARY_PROBE_BYTES = 8192;

/** Time box of every elevated command the viewer runs. */
const FILE_VIEWER_COMMAND_TIMEOUT_MS = 30_000;

// The viewer's command exit codes (and the neighbours they must not collide with) are distinct on
// purpose: 42 (directory) and 43 (not a regular file) are `readWorkingTreeFile`'s, 44, 46 and 47 are
// below, 125 is `CWD_FAILED_EXIT_CODE` (the elevated cd guard) and 137 is a timed-out run. Callers
// tell the outcomes apart by exit code alone, so none may be reused.

/** Exit code of the listing command: the (existing) target is not a directory. */
const LISTING_NOT_A_DIRECTORY_EXIT_CODE = 44;
/** Exit code of the realpath command: the working directory itself cannot be resolved. */
const REALPATH_ROOT_UNAVAILABLE_EXIT_CODE = 46;
/** Exit code of the realpath command: the target does not exist (dangling links included). */
const REALPATH_TARGET_MISSING_EXIT_CODE = 47;

/** Seams for tests; production passes none. */
export interface FileViewerDeps {
  runAsUser: (opts: RunAsUserOpts) => Promise<RunAsUserResult>;
  readWorkingTreeFile: typeof readWorkingTreeFile;
  /** Content cap in bytes. */
  maxBytes: number;
}

function resolveDeps(deps: Partial<FileViewerDeps> | undefined): FileViewerDeps {
  return {
    runAsUser: deps?.runAsUser ?? runAsUser,
    readWorkingTreeFile: deps?.readWorkingTreeFile ?? readWorkingTreeFile,
    maxBytes: deps?.maxBytes ?? serverConfig.FILE_VIEWER_MAX_BYTES,
  };
}

// ============================================================
// Command builders (the exact strings are pinned by tests)
// ============================================================

/**
 * Shell command that lists one directory level without following symlinks:
 * a directory probe (exit `LISTING_NOT_A_DIRECTORY_EXIT_CODE` when the path is
 * not one), then three portable `find ... -print0` runs -- directories,
 * symlinks, and the complement `! -type d ! -type l` -- separated by two NULs.
 * The complement, not `-type f`, so fifos, sockets and devices are listed
 * (as files) instead of dropped. Only `-mindepth`, `-maxdepth`, `-type` and
 * `-print0` are used, the subset BSD and GNU `find` share.
 *
 * `absDir` is an ABSOLUTE path with no symlink component (the real path the
 * containment check produced), so `find` does not need `-H` to enter it.
 * @internal Exported for testing
 */
export function buildDirectoryListingCommand(absDir: string): string {
  const dir = shellEscape(absDir);
  const level = `${dir} -mindepth 1 -maxdepth 1`;
  return [
    `test -d ${dir} || exit ${LISTING_NOT_A_DIRECTORY_EXIT_CODE}`,
    `find ${level} -type d -print0`,
    `printf '\\000\\000'`,
    `find ${level} -type l -print0`,
    `printf '\\000\\000'`,
    `find ${level} ! -type d ! -type l -print0`,
  ].join('; ');
}

/**
 * Shell command that prints the real path of the working directory and of the
 * target (exactly two lines), as the user the shell runs as. Exits
 * `REALPATH_ROOT_UNAVAILABLE_EXIT_CODE` / `REALPATH_TARGET_MISSING_EXIT_CODE`
 * when either cannot be resolved; the explicit `test -d` / `test -e` are what
 * make a missing root or leaf a failure on every `realpath` (GNU's default
 * tolerates a missing last component).
 * Both arguments are ABSOLUTE. The command holds no shell variable and no `$`
 * at all: the elevated login shell expands `$` before the inner `sh -c` runs
 * (`.claude/rules/elevation-helpers.md`), so a variable would arrive empty.
 * @internal Exported for testing
 */
export function buildRealpathCommand(absRoot: string, absTarget: string): string {
  const root = shellEscape(absRoot);
  const target = shellEscape(absTarget);
  return [
    `test -d ${root} || exit ${REALPATH_ROOT_UNAVAILABLE_EXIT_CODE}`,
    `realpath -- ${root} || exit ${REALPATH_ROOT_UNAVAILABLE_EXIT_CODE}`,
    `test -e ${target} || exit ${REALPATH_TARGET_MISSING_EXIT_CODE}`,
    `realpath -- ${target} || exit ${REALPATH_TARGET_MISSING_EXIT_CODE}`,
  ].join('; ');
}

// ============================================================
// Listing output
// ============================================================

/**
 * Parse the three-section output of {@link buildDirectoryListingCommand}.
 * Each name is followed by one NUL and each section boundary is two NULs; a
 * file name cannot contain NUL, so an empty piece between NULs can only be a
 * separator, and separators come in pairs. Anything else is malformed and
 * fails closed. Names come back as the path `find` printed (`<absDir>/<name>`);
 * the prefix is stripped here.
 * @internal Exported for testing
 */
export function parseDirectoryListing(stdout: string, absDir: string): FileTreeEntry[] {
  const pieces = stdout.split('\0');
  if (pieces.pop() !== '') throw new Error('listing output does not end with a NUL terminator');

  const kinds: FileTreeEntry['kind'][] = ['dir', 'symlink', 'file'];
  const prefix = `${absDir}/`;
  const entries: FileTreeEntry[] = [];
  let section = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === '') {
      if (pieces[i + 1] !== '') throw new Error('listing output has an unpaired section separator');
      i++;
      section++;
      continue;
    }
    if (section >= kinds.length || !piece.startsWith(prefix)) {
      throw new Error('listing output has an unexpected entry');
    }
    entries.push({ name: piece.slice(prefix.length), kind: kinds[section] });
  }
  if (section !== kinds.length - 1) throw new Error('listing output has the wrong number of sections');
  return entries;
}

/** Directories first, then names by plain byte-order comparison (never the host locale). */
function sortEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return entries.sort((a, b) => {
    const aDir = a.kind === 'dir';
    const bDir = b.kind === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// ============================================================
// Containment
// ============================================================

function isWithin(candidate: string, root: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function describeTarget(kind: 'file' | 'directory'): string {
  return kind === 'file' ? 'File' : 'Directory';
}

/** Run a shell command as the session owner and turn the runner-level failures into errors. */
async function runChecked(
  deps: FileViewerDeps,
  requestUser: string,
  locationPath: string,
  command: string,
  what: string,
): Promise<RunAsUserResult> {
  let result: RunAsUserResult;
  try {
    result = await deps.runAsUser({
      username: requestUser,
      command,
      cwd: locationPath,
      timeoutMs: FILE_VIEWER_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    logger.error({ err: error, locationPath }, `File viewer ${what} could not be started`);
    throw new InternalError(`Could not ${what}`);
  }
  if (result.timedOut) throw new InternalError(`Timed out trying to ${what}`);
  if (result.cwdFailed) throw new NotFoundError('Working directory');
  return result;
}

/**
 * Resolve `relPath` (already lexically validated) under `locationPath` to its
 * real path as the session owner, and refuse it when that is outside the real
 * working directory.
 * @returns the real absolute path of the target
 * @throws NotFoundError when the working directory or the target does not exist
 * @throws ValidationError when the target resolves outside the working directory
 */
async function resolveConfinedRealPath(
  locationPath: string,
  relPath: string,
  requestUser: string | null,
  kind: 'file' | 'directory',
  deps: FileViewerDeps,
): Promise<string> {
  const absTarget = join(locationPath, relPath);
  let realRoot: string;
  let realTarget: string;

  if (requestUser === null || requestUser.length === 0) {
    try {
      realRoot = await realpath(locationPath);
    } catch (error) {
      if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        throw new NotFoundError('Working directory');
      }
      throw error;
    }
    try {
      realTarget = await realpath(absTarget);
    } catch (error) {
      if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
        throw new NotFoundError(describeTarget(kind));
      }
      throw error;
    }
  } else {
    const result = await runChecked(
      deps,
      requestUser,
      locationPath,
      buildRealpathCommand(locationPath, absTarget),
      'resolve the path',
    );
    if (result.exitCode === REALPATH_ROOT_UNAVAILABLE_EXIT_CODE) throw new NotFoundError('Working directory');
    if (result.exitCode === REALPATH_TARGET_MISSING_EXIT_CODE) throw new NotFoundError(describeTarget(kind));
    if (result.exitCode !== 0) {
      logger.error({ exitCode: result.exitCode, stderr: result.stderr, locationPath }, 'File viewer realpath failed');
      throw new InternalError('Could not resolve the path');
    }
    // Exactly two lines (root, target). A real path containing a newline
    // yields more and fails closed rather than being mis-split.
    const lines = result.stdout.split('\n');
    if (lines.length !== 3 || lines[2] !== '' || lines[0] === '' || lines[1] === '') {
      logger.error({ locationPath }, 'File viewer realpath returned an unexpected shape');
      throw new InternalError('Could not resolve the path');
    }
    [realRoot, realTarget] = lines;
  }

  if (!isWithin(realTarget, realRoot)) {
    throw new ValidationError('Path resolves outside the working directory');
  }
  return realTarget;
}

// ============================================================
// Public API
// ============================================================

/**
 * List one directory level of the working directory. `dir` is relative to
 * `locationPath`; the empty string is the root. Nothing is filtered: dotfiles
 * and `.git` are listed, and a symlink is listed as its own kind without being
 * followed (expanding it is a new request, which is containment-checked).
 *
 * @throws ValidationError for an invalid path, a target outside the working
 *   directory, or a target that is not a directory
 * @throws NotFoundError when the target does not exist
 */
export async function listDirectory(
  locationPath: string,
  dir: string,
  requestUser: string | null,
  overrides?: Partial<FileViewerDeps>,
): Promise<FileTreeResponse> {
  if (!isValidFilePath(dir)) throw new ValidationError('Invalid path');
  const deps = resolveDeps(overrides);
  const realDir = await resolveConfinedRealPath(locationPath, dir, requestUser, 'directory', deps);

  if (requestUser === null || requestUser.length === 0) {
    let dirents;
    try {
      dirents = await readdir(realDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOTDIR') throw new ValidationError('Path is not a directory');
      if (isErrnoException(error) && error.code === 'ENOENT') throw new NotFoundError('Directory');
      throw error;
    }
    const entries = dirents.map((dirent): FileTreeEntry => ({
      name: dirent.name,
      kind: dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'symlink' : 'file',
    }));
    return { path: dir, entries: sortEntries(entries) };
  }

  const result = await runChecked(
    deps,
    requestUser,
    locationPath,
    buildDirectoryListingCommand(realDir),
    'list the directory',
  );
  if (result.exitCode === LISTING_NOT_A_DIRECTORY_EXIT_CODE) throw new ValidationError('Path is not a directory');
  if (result.exitCode !== 0) {
    logger.error({ exitCode: result.exitCode, stderr: result.stderr, locationPath }, 'File viewer listing failed');
    throw new InternalError('Could not list the directory');
  }
  try {
    return { path: dir, entries: sortEntries(parseDirectoryListing(result.stdout, realDir)) };
  } catch (error) {
    logger.error({ err: error, locationPath }, 'File viewer listing output could not be parsed');
    throw new InternalError('Could not list the directory');
  }
}

/**
 * Read one file of the working directory. `relPath` is relative to
 * `locationPath` and must be non-empty. At most `maxBytes` (1 MiB by default)
 * of content come back, `truncated` when the file is larger; a file with a NUL
 * in its first 8 KiB is `binary` and carries no content. Content is decoded as
 * UTF-8 with replacement characters; a cut in the middle of a sequence is not
 * re-aligned. `size` is the file's total size, read together with the content;
 * truncation is decided from it, never from the length of what came back.
 *
 * Accepted limitation (elevated path only): `runAsUser` hands stdout back as a
 * UTF-8 string, so each invalid byte re-encodes as a 3-byte replacement
 * character and a NUL's position in the 8 KiB window can shift later for a
 * file full of invalid sequences.
 *
 * @throws ValidationError for an invalid path, a target outside the working
 *   directory, a directory, or a file that is not a regular file (fifo,
 *   socket, device)
 * @throws NotFoundError when the target does not exist
 */
export async function readFileContent(
  locationPath: string,
  relPath: string,
  requestUser: string | null,
  overrides?: Partial<FileViewerDeps>,
): Promise<FileContentResponse> {
  if (relPath === '' || !isValidFilePath(relPath)) throw new ValidationError('Invalid path');
  const deps = resolveDeps(overrides);
  const realTarget = await resolveConfinedRealPath(locationPath, relPath, requestUser, 'file', deps);

  // Read the REAL path the containment call returned, not the lexical join, so
  // the two calls cannot disagree if a symlink is swapped in between. The
  // builder joins its cwd and path, so the parent and the base name are passed
  // separately (the parent is a real directory inside the working directory).
  const read = await deps.readWorkingTreeFile(dirname(realTarget), basename(realTarget), requestUser, {
    regularOnly: true,
    maxBytes: deps.maxBytes,
  });
  if (read === null) throw new NotFoundError('File');
  if (read.kind === 'directory') throw new ValidationError('Path is a directory');
  if (read.kind === 'not-regular') throw new ValidationError('Not a regular file');

  const isBinary = read.content.subarray(0, FILE_VIEWER_BINARY_PROBE_BYTES).includes(0);
  if (isBinary) {
    return { path: relPath, kind: 'binary', size: read.size, truncated: false, language: UNKNOWN_PRISM_LANGUAGE };
  }

  return {
    path: relPath,
    kind: 'text',
    content: new TextDecoder('utf-8').decode(read.content),
    size: read.size,
    truncated: read.size > deps.maxBytes,
    language: prismLanguageForPath(relPath),
  };
}
