/**
 * Tests for MultiUserMode OS user lookup and credential validation.
 *
 * Verifies that:
 * - lookupMacOsUser uses Bun.spawn with array args (not shell template)
 * - lookupLinuxUser uses Bun.spawn with array args (not shell template)
 * - validateMacOs uses Bun.spawn with array args
 * - validateLinux uses Bun.spawn with array args
 *
 * These are tested through the public login() method by spying on Bun.spawn
 * and os.platform() to control which platform path is taken.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as os from 'os';
import type { Kysely } from 'kysely';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { MultiUserMode } from '../user-mode.js';
import type { PtyProvider } from '../../lib/pty-provider.js';

const mockPtyProvider: PtyProvider = {
  spawn: () => { throw new Error('not implemented'); },
};

/**
 * Create a mock Bun.spawn return value with controllable stdout and exit code.
 */
function createMockProc(stdout: string, exitCode: number = 0) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(stdout));
      controller.close();
    },
  });
  return {
    stdout: stream,
    stderr: null,
    stdin: { write: () => {}, end: () => {} },
    exited: Promise.resolve(exitCode),
    pid: 12345,
    kill: () => {},
  };
}

describe('MultiUserMode', () => {
  let db: Kysely<any>;
  let platformSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
  });

  afterEach(async () => {
    if (platformSpy) platformSpy.mockRestore();
    await db.destroy();
  });

  describe('lookupMacOsUser uses Bun.spawn with array args', () => {
    it('should call Bun.spawn with array args for dscl commands', async () => {
      platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');

      const spawnCalls: unknown[][] = [];
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
        spawnCalls.push(args);
        const cmd = args[0] as string[];
        if (cmd[0] === 'dscl' && cmd[4] === 'UniqueID') {
          return createMockProc('UniqueID: 501\n') as any;
        }
        if (cmd[0] === 'dscl' && cmd[4] === 'NFSHomeDirectory') {
          return createMockProc('NFSHomeDirectory: /Users/testuser\n') as any;
        }
        // Auth validation call
        if (cmd[0] === 'dscl' && cmd[2] === '-authonly') {
          return createMockProc('', 0) as any;
        }
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);
        await mode.login('testuser', 'testpass');

        // Verify dscl UniqueID lookup uses array args
        const uidCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('UniqueID'),
        );
        expect(uidCall).toBeDefined();
        expect(uidCall![0]).toEqual(['dscl', '.', '-read', '/Users/testuser', 'UniqueID']);

        // Verify dscl NFSHomeDirectory lookup uses array args
        const homeCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('NFSHomeDirectory'),
        );
        expect(homeCall).toBeDefined();
        expect(homeCall![0]).toEqual(['dscl', '.', '-read', '/Users/testuser', 'NFSHomeDirectory']);
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });

  describe('lookupLinuxUser uses Bun.spawn with array args', () => {
    it('should call Bun.spawn with array args for id and getent commands', async () => {
      platformSpy = spyOn(os, 'platform').mockReturnValue('linux');

      const spawnCalls: unknown[][] = [];
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
        spawnCalls.push(args);
        const cmd = args[0] as string[];
        if (cmd[0] === 'id') {
          return createMockProc('1001\n') as any;
        }
        if (cmd[0] === 'getent') {
          return createMockProc('testuser:x:1001:1001:Test User:/home/testuser:/bin/bash\n') as any;
        }
        // pamtester auth validation
        if (cmd[0] === 'pamtester') {
          const proc = createMockProc('', 0) as any;
          proc.stdin = { write: () => {}, end: () => {} };
          return proc;
        }
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);
        await mode.login('testuser', 'testpass');

        // Verify id command uses array args
        const idCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[])[0] === 'id',
        );
        expect(idCall).toBeDefined();
        expect(idCall![0]).toEqual(['id', '-u', 'testuser']);

        // Verify getent command uses array args
        const getentCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[])[0] === 'getent',
        );
        expect(getentCall).toBeDefined();
        expect(getentCall![0]).toEqual(['getent', 'passwd', 'testuser']);
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });

  describe('validateMacOs uses Bun.spawn with array args', () => {
    it('should call dscl -authonly with array args (no shell)', async () => {
      platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');

      const spawnCalls: unknown[][] = [];
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
        spawnCalls.push(args);
        const cmd = args[0] as string[];
        if (cmd[0] === 'dscl' && cmd[2] === '-authonly') {
          return createMockProc('', 0) as any;
        }
        if (cmd[0] === 'dscl' && cmd[4] === 'UniqueID') {
          return createMockProc('UniqueID: 501\n') as any;
        }
        if (cmd[0] === 'dscl' && cmd[4] === 'NFSHomeDirectory') {
          return createMockProc('NFSHomeDirectory: /Users/testuser\n') as any;
        }
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);
        await mode.login('testuser', 'secret$pass');

        // Verify dscl -authonly uses array args with password as separate arg
        const authCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('-authonly'),
        );
        expect(authCall).toBeDefined();
        expect(authCall![0]).toEqual(['dscl', '.', '-authonly', 'testuser', 'secret$pass']);
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });

  describe('validateLinux uses Bun.spawn with array args', () => {
    it('should call pamtester with array args and write password to stdin', async () => {
      platformSpy = spyOn(os, 'platform').mockReturnValue('linux');

      const spawnCalls: unknown[][] = [];
      let stdinData = '';
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
        spawnCalls.push(args);
        const cmd = args[0] as string[];
        if (cmd[0] === 'pamtester') {
          const proc = createMockProc('', 0) as any;
          proc.stdin = {
            write: (data: string) => { stdinData += data; },
            end: () => {},
          };
          return proc;
        }
        if (cmd[0] === 'id') {
          return createMockProc('1001\n') as any;
        }
        if (cmd[0] === 'getent') {
          return createMockProc('testuser:x:1001:1001::/home/testuser:/bin/bash\n') as any;
        }
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);
        await mode.login('testuser', 'secret$pass');

        // Verify pamtester uses array args
        const pamCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[])[0] === 'pamtester',
        );
        expect(pamCall).toBeDefined();
        expect(pamCall![0]).toEqual(['pamtester', 'login', 'testuser', 'authenticate']);

        // Verify password was written to stdin (not as command arg)
        expect(stdinData).toBe('secret$pass\n');
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });
});
