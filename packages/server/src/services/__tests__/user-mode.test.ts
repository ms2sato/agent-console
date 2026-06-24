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
import type { TerminalPtySpawnRequest } from '../user-mode.js';
import type { PtyProvider, PtySpawnOptions, PtyInstance } from '../../lib/pty-provider.js';

const mockPtyProvider: PtyProvider = {
  spawn: () => { throw new Error('not implemented'); },
};

/**
 * A PtyProvider that records the last spawn() call instead of starting a real PTY.
 */
function createCapturingPtyProvider(): {
  provider: PtyProvider;
  lastCall: () => [string, string[], PtySpawnOptions];
} {
  let last: [string, string[], PtySpawnOptions] | undefined;
  return {
    provider: {
      spawn(command, args, options) {
        last = [command, args, options];
        return {} as PtyInstance;
      },
    },
    lastCall: () => {
      if (!last) throw new Error('spawn was not called');
      return last;
    },
  };
}

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

  describe('spawnPty() - direct spawn cwd (#802 regression)', () => {
    // Single-user mode spawns directly as the server process user (no privilege
    // drop), so the pre-exec chdir runs as that same user. request.cwd must stay
    // as the outer cwd here — unlike the privileged sudo path, there is no
    // service-user traverse problem to avoid. This guards against the #802 fix
    // accidentally neutralizing the cwd of the unprivileged direct-spawn path.
    it('should pass request.cwd as the outer spawn cwd', () => {
      const { provider, lastCall } = createCapturingPtyProvider();
      const cachedUser = { id: 'cached-id', username: 'cached', homeDir: '/home/cached' };
      const userMode = new SingleUserMode(provider, cachedUser);

      const request: TerminalPtySpawnRequest = {
        type: 'terminal',
        username: 'cached',
        cwd: '/home/cached/project',
        additionalEnvVars: {},
        cols: 80,
        rows: 24,
      };

      userMode.spawnPty(request);

      const [, , opts] = lastCall();
      expect(opts.cwd).toBe('/home/cached/project');
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

  describe('OS user lookup is delegated to standalone helper', () => {
    it('does not expose lookupOsUser as a method on MultiUserMode', async () => {
      const userRepository = new SqliteUserRepository(db);
      const mode = await MultiUserMode.create(mockPtyProvider, userRepository);

      // After the os-user-lookup extraction, MultiUserMode no longer carries
      // its own lookupOsUser private method. The login() path now imports
      // the standalone helper from os-user-lookup.ts.
      expect(typeof (mode as unknown as { lookupOsUser?: unknown }).lookupOsUser).toBe('undefined');
    });

    it('returns null login when OS user lookup fails (unknown user)', async () => {
      platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');

      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
        const cmd = args[0] as string[];
        if (cmd[0] === 'dscl' && cmd[2] === '-authonly') {
          // Auth succeeds.
          return createMockProc('', 0) as any;
        }
        // Lookup fails (no UniqueID / NFSHomeDirectory output).
        return createMockProc('', 1) as any;
      });

      try {
        const userRepository = new SqliteUserRepository(db);
        const mode = await MultiUserMode.create(mockPtyProvider, userRepository);

        const result = await mode.login('ghost-user', 'pw');

        expect(result).toBeNull();
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

  describe('spawnPty - sudo path preserves FORCE_COLOR', () => {
    // Mirror of the multi-user-mode.test.ts coverage so the sibling test for
    // user-mode.ts is touched in the same PR that introduces the
    // --preserve-env=FORCE_COLOR sudo arg (Issue #821 / PR #825 follow-up).
    // sudo -i resets the env to the sudoers env_keep defaults, which strips
    // FORCE_COLOR. Node-based agents (chalk) then fall back to 256-color even
    // when COLORTERM=truecolor is exported in the inner command. Passing
    // --preserve-env=FORCE_COLOR restores truecolor output across the privilege
    // boundary.
    it('should include --preserve-env=FORCE_COLOR between -u <user> and -i when spawning via sudo', async () => {
      const { provider, lastCall } = createCapturingPtyProvider();
      const userRepository = new SqliteUserRepository(db);
      const mode = await MultiUserMode.create(provider, userRepository);

      const request: TerminalPtySpawnRequest = {
        type: 'terminal',
        // Use a username that cannot match os.userInfo().username so we always
        // take the spawnSudoPty branch regardless of the host the test runs on.
        username: 'definitely-not-the-server-user',
        cwd: '/workspace',
        additionalEnvVars: {},
        cols: 80,
        rows: 24,
      };

      mode.spawnPty(request);

      const [cmd, args] = lastCall();
      expect(cmd).toBe('sudo');
      expect(args[0]).toBe('-u');
      expect(args[1]).toBe('definitely-not-the-server-user');
      expect(args[2]).toBe('--preserve-env=FORCE_COLOR');
      expect(args[3]).toBe('-i');
    });

    // Issue #863 — env-filter's curated child env (TERM=xterm-256color,
    // COLORTERM=truecolor, FORCE_COLOR=3, ...) must be exported in the
    // inner shell so chalk-based CLIs (claude) render in color. The
    // previous design relied on sudo's env_keep defaults, which on
    // Ubuntu sudo strip TERM and leave it as 'unknown' — observed on
    // the dogfood host as all-white claude output.
    it('exports TERM=xterm-256color, COLORTERM=truecolor, and FORCE_COLOR=3 in the inner shell command (Issue #863)', async () => {
      const { provider, lastCall } = createCapturingPtyProvider();
      const userRepository = new SqliteUserRepository(db);
      const mode = await MultiUserMode.create(provider, userRepository);

      const request: TerminalPtySpawnRequest = {
        type: 'terminal',
        username: 'definitely-not-the-server-user',
        cwd: '/workspace',
        additionalEnvVars: {},
        cols: 80,
        rows: 24,
      };

      mode.spawnPty(request);

      const [, args] = lastCall();
      // sudo arg shape: -u <user> --preserve-env=FORCE_COLOR -i sh -c <innerCommand>
      const innerCommand = args[6] as string;
      expect(innerCommand).toContain("TERM='xterm-256color'");
      expect(innerCommand).toContain("COLORTERM='truecolor'");
      expect(innerCommand).toContain("FORCE_COLOR='3'");

      // Negative assertions (Issue #866): bun server's env (PATH / HOME /
      // USER / SHELL / LOGNAME — agentconsole's values when the server runs
      // multi-user) must NOT cross the privilege boundary. The elevated
      // user's natural login env (established by `sudo -i`'s shell init) is
      // the source of truth for those vars; overriding them broke PATH
      // lookup and surfaced as `sh: 1: claude: Permission denied` on the
      // dogfood host. The previous Issue #863 fix attempt inadvertently
      // injected them via `getCleanChildProcessEnv()`; this assertion locks
      // in that they are no longer exported from this path.
      expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
      expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bHOME=/);
      expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bUSER=/);
      expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bSHELL=/);
      expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bLOGNAME=/);
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
