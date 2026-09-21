import { describe, it, expect } from 'bun:test';
import { assertCanOperateSession } from '../session-access.js';
import { ForbiddenError } from '../errors.js';
import * as path from 'path';

const AUTH_USER = { id: 'user-1' };
const SHARED_REGISTRY_NONE = { isSharedUserId: () => false };
const SHARED_REGISTRY_MATCHES = { isSharedUserId: (id: string) => id === 'shared-user' };

describe('assertCanOperateSession', () => {
  it('does not throw for the session owner in multi-user mode', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'user-1' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('does not throw for a shared-session creator, even though the caller is not the owner', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'shared-user' },
        AUTH_USER,
        SHARED_REGISTRY_MATCHES,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('throws ForbiddenError with the given message for a non-owner, non-shared session in multi-user mode', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).toThrow(ForbiddenError);
    try {
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      );
      throw new Error('expected assertCanOperateSession to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).message).toBe('Only the session owner can do this');
    }
  });

  it('never throws outside multi-user mode, regardless of ownership', () => {
    expect(() =>
      assertCanOperateSession(
        { createdBy: 'someone-else' },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'none',
        'Only the session owner can do this',
      ),
    ).not.toThrow();
  });

  it('does not throw for a legacy session with createdBy undefined, in multi-user mode (isOwner and isSharedSession both false, but the DB nullability precedent (R5) is intentionally NOT re-derived here)', () => {
    // `createdBy: undefined` makes `isOwner` false (authUser.id !== undefined)
    // and `isSharedSession` false (`session.createdBy != null` short-circuits).
    // The three original call sites in routes/sessions.ts accepted this as a
    // 403 in multi-user mode (R5's ruling is about single-user mode, not
    // this one) -- this test pins the CURRENT behavior (throws), not a new
    // guarantee. See docs/design/session-worker-design.md#session-memo.
    expect(() =>
      assertCanOperateSession(
        { createdBy: undefined },
        AUTH_USER,
        SHARED_REGISTRY_NONE,
        'multi-user',
        'Only the session owner can do this',
      ),
    ).toThrow(ForbiddenError);
  });
});

/**
 * Adoption containment (grep-based, modeled on
 * `mcp/__tests__/pty-notification-delivery-containment.test.ts`'s
 * `writePtyNotification` exact-set block). Guards against a future route
 * handler re-inlining the `isOwner`/`isSharedSession` check that
 * `assertCanOperateSession` above was extracted to replace -- a silent
 * reintroduction would drift the check out of sync with `session-access.ts`
 * without either file's own tests noticing.
 *
 * Runs the real-fs grep in a FRESH subprocess, not this test file's own `fs`
 * module: other suites in the same `bun test` invocation mock `fs`/`node:fs`
 * process-globally via `mock.module` (permanent for the life of the
 * process, no unmock in bun:test), so a plain `fs.readFileSync` here could
 * silently read memfs's (emptied-by-cleanup) virtual filesystem instead of
 * the real repo tree depending on suite ordering -- see the sibling
 * containment test's own comment for the identical rationale.
 */
describe('isSharedUserId(session.createdBy) adoption containment (grep-based)', () => {
  const SERVER_SRC = path.resolve(__dirname, '../..');
  const PATTERN_SOURCE = 'isSharedUserId\\(session\\.createdBy\\)';

  async function grepPattern(serverSrc: string, relativeGlobDir: string): Promise<Record<string, number>> {
    const probe = `
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(${JSON.stringify(serverSrc)}, ${JSON.stringify(relativeGlobDir)});
      const pattern = new RegExp(${JSON.stringify(PATTERN_SOURCE)}, 'g');
      const counts = {};
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/\\.ts$/.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const matches = content.match(pattern);
        if (matches) counts[entry.name] = matches.length;
      }
      process.stdout.write(JSON.stringify(counts));
    `;
    const proc = Bun.spawn(['bun', '-e', probe], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`grepPattern probe failed (exit ${exitCode}): ${stderr}`);
    }
    return JSON.parse(stdout) as Record<string, number>;
  }

  it('POSITIVE CONTROL: session-access.ts itself contains the pattern exactly once -- proves the grep mechanism can actually see a real occurrence', async () => {
    const counts = await grepPattern(SERVER_SRC, 'lib');
    expect(counts['session-access.ts']).toBe(1);
  });

  it('no route handler under routes/ re-inlines isSharedUserId(session.createdBy) -- the extraction to assertCanOperateSession must stay the single writer', async () => {
    const counts = await grepPattern(SERVER_SRC, 'routes');
    expect(counts).toEqual({});
  });
});
