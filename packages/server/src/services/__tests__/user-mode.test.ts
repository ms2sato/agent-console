/**
 * Tests for SingleUserMode and MultiUserMode.
 *
 * SingleUserMode tests verify:
 * - SingleUserMode.create() upserts the server process user
 * - authenticate() returns AuthUser with stable id
 * - login() returns AuthUser with stable id
 * - Direct constructor works for tests with pre-built AuthUser
 *
 * MultiUserMode tests verify:
 * - lookupMacOsUser uses Bun.spawn with array args (not shell template)
 * - lookupLinuxUser uses Bun.spawn with array args (not shell template)
 * - validateMacOs uses Bun.spawn with array args
 * - validateLinux uses Bun.spawn with array args
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as os from 'os';
import type { Kysely } from 'kysely';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SingleUserMode, MultiUserMode } from '../user-mode.js';
import type { PtyProvider } from '../../lib/pty-provider.js';

const mockPtyProvider: PtyProvider = {
  spawn: () => { throw new Error('not implemented'); },
};

describe('SingleUserMode', () => {
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createDatabaseForTest();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('create() factory method', () => {
    it('should upsert server process user and cache result', async () => {
      const userRepository = new SqliteUserRepository(db);
      const userMode = await SingleUserMode.create(mockPtyProvider, userRepository);

      const authUser = userMode.authenticate(() => undefined);

      // Should have a valid UUID
      expect(authUser).not.toBeNull();
      expect(authUser!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(authUser!.username).toBeDefined();
      expect(authUser!.homeDir).toBeDefined();
    });

    it('should return same id on repeated calls (stable identity)', async () => {
      const userRepository = new SqliteUserRepository(db);

      const mode1 = await SingleUserMode.create(mockPtyProvider, userRepository);
      const mode2 = await SingleUserMode.create(mockPtyProvider, userRepository);

      const user1 = mode1.authenticate(() => undefined);
      const user2 = mode2.authenticate(() => undefined);

      // Same OS UID -> same user ID
      expect(user1!.id).toBe(user2!.id);
    });

    it('should persist user to database', async () => {
      const userRepository = new SqliteUserRepository(db);
      const userMode = await SingleUserMode.create(mockPtyProvider, userRepository);

      const authUser = userMode.authenticate(() => undefined)!;

      // Verify user exists in database
      const found = await userRepository.findById(authUser.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(authUser.id);
      expect(found!.username).toBe(authUser.username);
    });
  });

  describe('authenticate()', () => {
    it('should always return cached user (ignores token)', async () => {
      const cachedUser = { id: 'cached-id', username: 'cached', homeDir: '/home/cached' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      // Should return cached user regardless of token
      const result1 = userMode.authenticate(() => undefined);
      const result2 = userMode.authenticate(() => 'some-token');

      expect(result1).toEqual(cachedUser);
      expect(result2).toEqual(cachedUser);
    });

    it('should include id in returned AuthUser', async () => {
      const cachedUser = { id: 'test-uuid-123', username: 'testuser', homeDir: '/home/test' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      const result = userMode.authenticate(() => undefined);
      expect(result!.id).toBe('test-uuid-123');
    });
  });

  describe('login()', () => {
    it('should return null (login is not a valid operation in single-user mode)', async () => {
      const cachedUser = { id: 'cached-id', username: 'cached', homeDir: '/home/cached' };
      const userMode = new SingleUserMode(mockPtyProvider, cachedUser);

      const result = await userMode.login('any-user', 'any-password');

      expect(result).toBeNull();
    });
  });
});

// ========== MultiUserMode ==========

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
        if (cmd[0] === 'dscl' && cmd[2] === '-authonly') {
          return createMockProc('', 0) as any;
        }
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);
        await mode.login('testuser', 'testpass');

        const uidCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('UniqueID'),
        );
        expect(uidCall).toBeDefined();
        expect(uidCall![0]).toEqual(['dscl', '.', '-read', '/Users/testuser', 'UniqueID']);

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

        const idCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[])[0] === 'id',
        );
        expect(idCall).toBeDefined();
        expect(idCall![0]).toEqual(['id', '-u', 'testuser']);

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

        const pamCall = spawnCalls.find(
          (c) => Array.isArray(c[0]) && (c[0] as string[])[0] === 'pamtester',
        );
        expect(pamCall).toBeDefined();
        expect(pamCall![0]).toEqual(['pamtester', 'login', 'testuser', 'authenticate']);

        expect(stdinData).toBe('secret$pass\n');
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });
});
