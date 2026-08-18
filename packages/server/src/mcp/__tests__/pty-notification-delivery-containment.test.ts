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
