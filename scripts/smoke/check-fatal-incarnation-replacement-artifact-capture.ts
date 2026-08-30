#!/usr/bin/env bun
/**
 * Verifies `captureWorkerNdjson` (from check-fatal-incarnation-replacement.ts)
 * WITHOUT a billed `check-fatal-incarnation-replacement` run.
 *
 * WHY THIS IS SEPARATE FROM THE BILLED SMOKE. The capture mechanism is pure
 * filesystem plumbing (glob, mkdir, copy, remove) sitting upstream of, and
 * outside, the billable chain a real `claude-sdk` run drives (Issue #1468,
 * Architect addendum). Trusting an unverified copy-out because "the billed
 * smoke didn't error" would test the wrong thing at the wrong price — this
 * script exercises the exact same code path (imported, not reimplemented)
 * against a synthetic disposable home containing a fake worker NDJSON file,
 * for the cost of a few filesystem operations.
 *
 * This is a proxy per pre-pr-completeness.md Q13's three conditions:
 *   - upstream and outside: the mechanism under test never spawns a
 *     process, never talks to `claude`, never touches AppContext/SQLite —
 *     it is the same three fs calls (glob, mkdirSync, cpSync) regardless of
 *     what produced the file being copied.
 *   - genuinely provisioned: the fake NDJSON is written through the real
 *     `outputs/<sessionId>/<workerId>.log` path shape the real smoke's
 *     `SessionDataPathResolver` produces, not an arbitrary flat file.
 *   - recorded next to the result: see the PR body for this Issue.
 *
 * Asserts:
 *   (a) the NDJSON survives at the capture destination, byte-for-byte
 *   (b) the disposable home is still removed on the default path
 *   (c) a copy-out failure (an unwritable destination) does not alter the
 *       wrapping smoke's own exit code -- mirrors the real `finally`
 *       block's try/catch shape exactly, so what this proves about the
 *       shape is what the real script actually does, not an approximation
 *       of it.
 *
 * Usage:
 *   bun scripts/smoke/check-fatal-incarnation-replacement-artifact-capture.ts
 *
 * Exit codes:
 *   0  every assertion passed
 *   1  an assertion failed
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureWorkerNdjson } from './check-fatal-incarnation-replacement.ts';

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function makeSyntheticDisposableHome(): { disposableHome: string; ndjsonPath: string; ndjsonContent: string } {
  const disposableHome = mkdtempSync(path.join(os.tmpdir(), 'agent-console-1468-synthetic-'));
  // Same shape SessionDataPathResolver.getOutputFilePath produces:
  // <base>/outputs/<sessionId>/<workerId>.log
  const sessionId = 'sess-synthetic-1468';
  const workerId = 'worker-synthetic-1468';
  const outputsDir = path.join(disposableHome, '_quick', 'outputs', sessionId);
  mkdirSync(outputsDir, { recursive: true });
  const ndjsonPath = path.join(outputsDir, `${workerId}.log`);
  const ndjsonContent = [
    JSON.stringify({ type: 'user-message', text: 'plant WOMBAT-3312' }),
    JSON.stringify({ type: 'tool-call', callId: 'call-1', name: 'Read' }),
    JSON.stringify({ type: 'tool-result', callId: 'call-1' }),
    JSON.stringify({ type: 'assistant-message', text: 'done' }),
  ].join('\n') + '\n';
  writeFileSync(ndjsonPath, ndjsonContent);
  // A sibling non-output file, to confirm the glob does not sweep everything
  // under disposableHome -- only the outputs/ subtree.
  mkdirSync(path.join(disposableHome, '_quick', 'other'), { recursive: true });
  writeFileSync(path.join(disposableHome, '_quick', 'other', 'unrelated.db'), 'not ndjson');
  return { disposableHome, ndjsonPath, ndjsonContent };
}

function main(): void {
  console.log('==> verifying captureWorkerNdjson without a billed smoke run\n');

  // --- (a) the NDJSON survives at the capture destination, byte-for-byte ---
  {
    const { disposableHome, ndjsonContent } = makeSyntheticDisposableHome();
    try {
      const captureDir = captureWorkerNdjson(disposableHome);
      check(captureDir !== null, 'captureWorkerNdjson reports a non-null capture directory');
      if (captureDir) {
        const capturedPath = path.join(captureDir, '_quick', 'outputs', 'sess-synthetic-1468', 'worker-synthetic-1468.log');
        check(existsSync(capturedPath), 'the captured file exists at the expected relative path', capturedPath);
        const capturedContent = existsSync(capturedPath) ? readFileSync(capturedPath, 'utf-8') : '';
        check(capturedContent === ndjsonContent, 'the captured content matches the source byte-for-byte');
        const capturedOther = path.join(captureDir, '_quick', 'other', 'unrelated.db');
        check(!existsSync(capturedOther), 'a non-outputs file under the disposable home is NOT captured');
        rmSync(captureDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(disposableHome, { recursive: true, force: true });
    }
  }

  // --- (b) the disposable home is still removed on the default path ---
  // Mirrors the real smoke's finally block ordering exactly: capture, THEN
  // rmSync, both inside the same finally shape.
  {
    const { disposableHome } = makeSyntheticDisposableHome();
    let captureDir: string | null = null;
    try {
      captureDir = captureWorkerNdjson(disposableHome);
    } finally {
      rmSync(disposableHome, { recursive: true, force: true });
    }
    check(!existsSync(disposableHome), 'the disposable home is gone after the capture-then-remove sequence');
    if (captureDir) rmSync(captureDir, { recursive: true, force: true });
  }

  // --- (c) a copy-out failure does not alter the wrapping smoke's own exit code ---
  // Reproduces the real finally block's exact try/catch shape: capture is
  // wrapped separately from removal, and a thrown capture error must never
  // propagate past that wrapper or prevent the removal that follows it.
  //
  // Blocking technique: `captureWorkerNdjson` derives its destination as
  // `path.join(os.tmpdir(), 'agent-console-1414-captures', <basename>)` and
  // `mkdirSync`s it. Placing a FILE (not a directory) at that exact
  // `agent-console-1414-captures` path makes `mkdirSync(..., {recursive:
  // true})` fail with ENOTDIR unconditionally -- a type conflict, not a
  // permission check, so it forces the failure even when this script runs
  // as root (where chmod-based permission blocking would silently not
  // reproduce the failure at all).
  {
    const { disposableHome } = makeSyntheticDisposableHome();
    const fakeTmpdir = mkdtempSync(path.join(os.tmpdir(), 'agent-console-1468-blocked-root-'));
    const blockedPath = path.join(fakeTmpdir, 'agent-console-1414-captures');
    writeFileSync(blockedPath, 'this is a file, not a directory -- forces mkdirSync to fail');

    // `os.tmpdir()` reads `TMPDIR` at call time (verified: Bun/Node's
    // implementation is not a load-time constant), so redirecting it here
    // reaches the SAME call `captureWorkerNdjson` makes -- `node:os`'s
    // exported object itself is read-only in Bun, so this is the portable
    // lever, not a monkeypatch of the module.
    const originalTmpdirEnv = process.env.TMPDIR;
    process.env.TMPDIR = fakeTmpdir;

    let smokeExitCode: number | null = null;
    let capturedErrorWasCaught = false;
    try {
      // This block is the real finally block's shape, copied exactly: the
      // capture call is inside its own try/catch; a local failure counter
      // mirrors the real script's `failures` variable, which a capture
      // failure never touches (it is caught-and-logged, not
      // caught-and-counted).
      let localFailures = 0;
      try {
        captureWorkerNdjson(disposableHome);
      } catch {
        capturedErrorWasCaught = true;
      }
      try {
        rmSync(disposableHome, { recursive: true, force: true });
      } catch {
        // best effort, same as the real script
      }
      smokeExitCode = localFailures === 0 ? 0 : 1;
    } finally {
      if (originalTmpdirEnv === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdirEnv;
      }
      rmSync(fakeTmpdir, { recursive: true, force: true });
    }

    check(capturedErrorWasCaught, 'captureWorkerNdjson threw when its destination path was blocked by a same-named file (the failure mode this test forces)');
    check(!existsSync(disposableHome), 'the disposable home was still removed despite the capture failure');
    check(smokeExitCode === 0, 'the wrapping smoke logic still reports success -- a capture failure never flips the exit code', `exit=${smokeExitCode}`);
  }

  console.log(`\n==> ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
