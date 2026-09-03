import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Containment test (Issue #1351, grep-based -- modeled on
 * mcp-auth.test.ts's `McpCallerIdentity containment` block). Guards the
 * structural migration this Issue performed: composing a PTY notification
 * via `buildPtyNotificationText` and then handing the result to a plain
 * `sendUserMessage`/`sendEmbeddedAgentUserMessage` call is exactly the
 * regression shape `mcp-server.ts`'s send_session_message tool had before
 * this fix -- the notification lost its `notification` marker on the wire
 * because nothing distinguished it from a real user/API message.
 *
 * `EmbeddedAgentWorkerService.sendSystemNotification` (embedded-agent-worker
 * -service.ts) is now the ONLY place allowed to combine
 * `buildPtyNotificationText` with a user-message send -- it is the new
 * method's own internal implementation, and it attaches the `notification`
 * marker. `pty-notification.ts` itself is excluded because it's the
 * function's own defining file.
 */
describe('PTY-notification-to-plain-user-message containment (Issue #1351, grep-based)', () => {
  const SERVER_SRC = path.resolve(__dirname, '../..');

  const ALLOWED_FILES = new Set([
    path.join('services', 'embedded-agent-worker-service.ts'),
    path.join('lib', 'pty-notification.ts'),
  ]);

  function walkFiles(dir: string, acc: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        if (entry.name === 'node_modules') continue;
        walkFiles(fullPath, acc);
      } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
        acc.push(fullPath);
      }
    }
    return acc;
  }

  it('no file outside the notification method itself combines buildPtyNotificationText with a plain user-message send', () => {
    const buildTextPattern = /\bbuildPtyNotificationText\b/;
    const sendPattern = /\.sendUserMessage\(|\bsendEmbeddedAgentUserMessage\(/;

    const offenders: string[] = [];
    for (const file of walkFiles(SERVER_SRC)) {
      const relative = path.relative(SERVER_SRC, file);
      if (ALLOWED_FILES.has(relative)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (buildTextPattern.test(content) && sendPattern.test(content)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Exact-set containment test (Issue #1574, R1). `SessionManager.
 * deliverWorkerNotification` is now the single delivery seam for a
 * structured notification, and its PTY-backed branch is the only place in
 * the "PR A" scope (the notification queue / create_timer / create_
 * conditional_wakeup seam introduced by #1574) allowed to call
 * `writePtyNotification` directly. Every other DIRECT caller of
 * `writePtyNotification` outside `pty-notification.ts` itself (the
 * function's own defining file, excluded the same way the sibling test
 * above excludes it) must be one of the two categories below -- nothing
 * else.
 *
 * This is an EXACT-SET assertion, not merely "the app-context.ts callbacks
 * and mcp-server.ts's send_session_message don't call it directly anymore" --
 * a negative-only check would not fail if some new, unrelated file started
 * calling `writePtyNotification` directly. Sorting and diffing the full
 * caller set against a fixed expected list catches ANY new direct caller,
 * which is the actual invariant R1 wants enforced.
 */
describe('writePtyNotification direct-caller exact-set (Issue #1574, R1, grep-based)', () => {
  const SERVER_SRC = path.resolve(__dirname, '../..');
  const DEFINING_FILE = path.join('lib', 'pty-notification.ts');
  // The seam's own implementation (SessionManager.deliverWorkerNotification's
  // PTY-backed branch) -- "outside the seam's own implementation" is the
  // scope this exact-set governs, so this file is excluded the same way
  // DEFINING_FILE is, not counted as a fifth expected entry.
  const SEAM_FILE = path.join('services', 'session-manager.ts');

  // PERMANENTLY out of scope: unrelated notification kinds
  // (`inbound-event` / `internal-review-comment` / `internal-reviewed`),
  // both hard-scoped to `.type === 'agent'` workers only -- #1574 does not
  // touch these call sites and never will (they are not notification
  // TARGETS in the create_timer/create_conditional_wakeup/run_process sense
  // this Issue's guard predicates govern).
  const PERMANENTLY_OUT_OF_SCOPE = [
    path.join('services', 'inbound', 'handlers.ts'),
    path.join('routes', 'review-queue.ts'),
  ];

  // PR B's PENDING migration (run_process): the interactive-process EXIT
  // notification (`internal-process`, app-context.ts) and the stdout
  // content-routing notification (process-output-router.ts) are not yet
  // moved onto the seam -- that is #1574's follow-up PR, not this one.
  const PENDING_PR_B_MIGRATION = [
    path.join('app-context.ts'),
    path.join('services', 'process-output-router.ts'),
  ];

  /**
   * Runs the real-fs directory walk in a FRESH subprocess rather than this
   * test process's own `fs` module. Other test files in the same `bun test`
   * run mock `fs`/`node:fs` process-globally via `mock.module` (see
   * `__tests__/utils/mock-fs-helper.ts`), and `mock.module` is permanent for
   * the life of the process (bun:test has no unmock) -- so a plain
   * `fs.readdirSync` here would silently walk memfs's (emptied-by-cleanup)
   * virtual filesystem instead of the real repo tree whenever this file runs
   * after any memfs-using suite in the full `bun test` invocation, producing
   * a vacuous empty `actual` list rather than a thrown error. Spawning a
   * subprocess sidesteps the mock entirely, mirroring
   * `build-output.test.ts`'s `inspectDist` probe (same rationale, same
   * `Bun.spawn(['bun', '-e', ...])` shape).
   */
  async function findDirectCallers(serverSrc: string, excluded: string[]): Promise<string[]> {
    const probe = `
      const fs = require('fs');
      const path = require('path');
      const SERVER_SRC = ${JSON.stringify(serverSrc)};
      const EXCLUDED = new Set(${JSON.stringify(excluded)});
      function walkFiles(dir, acc) {
        acc = acc || [];
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return acc;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '__tests__') continue;
            if (entry.name === 'node_modules') continue;
            walkFiles(fullPath, acc);
          } else if (entry.isFile() && /\\.ts$/.test(entry.name)) {
            acc.push(fullPath);
          }
        }
        return acc;
      }
      const callPattern = /\\bwritePtyNotification\\(/;
      const actual = [];
      for (const file of walkFiles(SERVER_SRC)) {
        const relative = path.relative(SERVER_SRC, file);
        if (EXCLUDED.has(relative)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (callPattern.test(content)) {
          actual.push(relative);
        }
      }
      actual.sort();
      process.stdout.write(JSON.stringify(actual));
    `;
    const proc = Bun.spawn(['bun', '-e', probe], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`findDirectCallers probe failed (exit ${exitCode}): ${stderr}`);
    }
    return JSON.parse(stdout) as string[];
  }

  it('the full set of direct writePtyNotification callers outside its own defining file is EXACTLY the expected four files -- no more, no fewer', async () => {
    const expected = [...PERMANENTLY_OUT_OF_SCOPE, ...PENDING_PR_B_MIGRATION].sort();
    const actual = await findDirectCallers(SERVER_SRC, [DEFINING_FILE, SEAM_FILE]);

    expect(actual).toEqual(expected);
  });
});
