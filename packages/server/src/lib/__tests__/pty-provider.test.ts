import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  bunPtyProvider,
  bunTerminalProvider,
  getPtyProvider,
  type PtyProvider,
} from '../pty-provider.js';

describe('pty-provider', () => {
  describe('getPtyProvider', () => {
    it("returns bunPtyProvider when name is 'bun-pty'", () => {
      const provider = getPtyProvider('bun-pty');
      expect(provider).toBe(bunPtyProvider);
    });

    it("returns bunTerminalProvider when name is 'bun-terminal'", () => {
      const provider = getPtyProvider('bun-terminal');
      expect(provider).toBe(bunTerminalProvider);
    });

    it('exposes both providers as distinct PtyProvider implementations', () => {
      expect(bunPtyProvider).not.toBe(bunTerminalProvider);
      expect(typeof bunPtyProvider.spawn).toBe('function');
      expect(typeof bunTerminalProvider.spawn).toBe('function');
    });
  });

  describe('bunTerminalProvider', () => {
    type SpawnArgs = {
      cmd: string[];
      options: {
        cwd?: string;
        env?: Record<string, string>;
        terminal?: {
          cols?: number;
          rows?: number;
          name?: string;
          data?: (terminal: unknown, chunk: Uint8Array) => void;
          exit?: (terminal: unknown, exitCode: number, signal: string | null) => void;
        };
      };
    };

    let originalSpawn: typeof Bun.spawn;
    let lastSpawn: SpawnArgs | null;
    let mockTerminal: {
      write: ReturnType<typeof mock>;
      resize: ReturnType<typeof mock>;
      close: ReturnType<typeof mock>;
    };
    let mockSubprocess: {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof mock>;
      terminal: typeof mockTerminal;
      exited: Promise<number>;
      _resolveExited: (code: number) => void;
    };

    function makeMockSubprocess(pid: number): typeof mockSubprocess {
      let resolveExited: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });
      return {
        pid,
        exitCode: null,
        signalCode: null,
        kill: mock(() => {}),
        terminal: mockTerminal,
        exited,
        _resolveExited: (code: number) => {
          mockSubprocess.exitCode = code;
          resolveExited(code);
        },
      };
    }

    beforeEach(() => {
      originalSpawn = Bun.spawn;
      lastSpawn = null;
      mockTerminal = {
        write: mock(() => 0),
        resize: mock(() => {}),
        close: mock(() => {}),
      };
      mockSubprocess = makeMockSubprocess(99999);

      // Replace Bun.spawn for this test. The adapter calls Bun.spawn with a
      // single options object containing `terminal`; capture both and return
      // the mock subprocess so the adapter constructs against it.
      const fakeSpawn = (cmd: string[], options: SpawnArgs['options']) => {
        lastSpawn = { cmd, options };
        return mockSubprocess;
      };
      (Bun as { spawn: typeof Bun.spawn }).spawn = fakeSpawn as unknown as typeof Bun.spawn;
    });

    afterEach(() => {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    });

    it('spawns with terminal cols/rows/name and forwards cwd/env verbatim', () => {
      const env = {
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
      };
      bunTerminalProvider.spawn('bash', ['-l'], {
        cols: 120,
        rows: 30,
        cwd: '/tmp',
        env,
        name: 'xterm-256color',
      });

      expect(lastSpawn).not.toBeNull();
      expect(lastSpawn!.cmd).toEqual(['bash', '-l']);
      expect(lastSpawn!.options.cwd).toBe('/tmp');
      // env must be passed through unchanged so TERM/COLORTERM/FORCE_COLOR
      // reach the child (Bun.spawn does NOT merge parent env when env is set).
      expect(lastSpawn!.options.env).toBe(env);
      expect(lastSpawn!.options.terminal).toBeDefined();
      expect(lastSpawn!.options.terminal!.cols).toBe(120);
      expect(lastSpawn!.options.terminal!.rows).toBe(30);
      expect(lastSpawn!.options.terminal!.name).toBe('xterm-256color');
      expect(typeof lastSpawn!.options.terminal!.data).toBe('function');
    });

    it('defaults cols/rows/name when not provided', () => {
      bunTerminalProvider.spawn('sh', [], {});
      expect(lastSpawn!.options.terminal!.cols).toBe(80);
      expect(lastSpawn!.options.terminal!.rows).toBe(24);
      expect(lastSpawn!.options.terminal!.name).toBe('xterm-256color');
    });

    it('adapter exposes pid from the subprocess', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      expect(pty.pid).toBe(99999);
    });

    it('adapter onData receives decoded string when terminal data callback fires', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      const received: string[] = [];
      pty.onData((data) => received.push(data));

      const dataCb = lastSpawn!.options.terminal!.data!;
      dataCb(null, new TextEncoder().encode('hello '));
      dataCb(null, new TextEncoder().encode('world'));

      expect(received).toEqual(['hello ', 'world']);
    });

    it('adapter onData disposable detaches the listener', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      const received: string[] = [];
      const disp = pty.onData((data) => received.push(data));
      disp.dispose();

      const dataCb = lastSpawn!.options.terminal!.data!;
      dataCb(null, new TextEncoder().encode('ignored'));
      expect(received).toEqual([]);
    });

    it('adapter onExit fires when subprocess.exited resolves', async () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      const events: Array<{ exitCode: number; signal?: number | string }> = [];
      pty.onExit((event) => events.push(event));

      mockSubprocess._resolveExited(0);
      await mockSubprocess.exited;
      // exit listener fires asynchronously after `.then`. Flush microtasks.
      await Promise.resolve();
      await Promise.resolve();

      expect(events.length).toBe(1);
      expect(events[0]!.exitCode).toBe(0);
    });

    it('adapter onExit fires when subprocess.exited resolves with non-zero code', async () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      const events: Array<{ exitCode: number; signal?: number | string }> = [];
      pty.onExit((event) => events.push(event));

      mockSubprocess._resolveExited(137);
      await mockSubprocess.exited;
      await Promise.resolve();
      await Promise.resolve();

      expect(events[0]!.exitCode).toBe(137);
    });

    it('adapter onExit fires synchronously (via microtask) if process already exited before listener attached', async () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      // Simulate the process exiting before any onExit listener is attached
      mockSubprocess._resolveExited(2);
      await mockSubprocess.exited;
      await Promise.resolve();

      // Now attach the listener after the fact (mirrors worker-manager kill
      // path race where exit-wait listener is attached just before kill).
      const events: Array<{ exitCode: number; signal?: number | string }> = [];
      pty.onExit((event) => events.push(event));
      await Promise.resolve();
      await Promise.resolve();

      expect(events.length).toBe(1);
      expect(events[0]!.exitCode).toBe(2);
    });

    it('adapter write delegates to terminal.write', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      pty.write('echo hi\n');
      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write.mock.calls[0]![0]).toBe('echo hi\n');
    });

    it('adapter resize delegates to terminal.resize with cols/rows', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      pty.resize(132, 50);
      expect(mockTerminal.resize).toHaveBeenCalledTimes(1);
      expect(mockTerminal.resize.mock.calls[0]).toEqual([132, 50]);
    });

    it('adapter kill defaults to SIGTERM when no signal is provided', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      pty.kill();
      expect(mockSubprocess.kill).toHaveBeenCalledTimes(1);
      expect(mockSubprocess.kill.mock.calls[0]![0]).toBe('SIGTERM');
    });

    it('adapter kill forwards the requested signal', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      pty.kill('SIGINT');
      expect(mockSubprocess.kill.mock.calls[0]![0]).toBe('SIGINT');
    });

    it('adapter cols/rows reflect the requested terminal size', () => {
      const pty = bunTerminalProvider.spawn('sh', [], { cols: 200, rows: 60 });
      expect(pty.cols).toBe(200);
      expect(pty.rows).toBe(60);
    });

    it('adapter process returns the command name', () => {
      const pty = bunTerminalProvider.spawn('zsh', [], {});
      expect(pty.process).toBe('zsh');
    });

    it('decoder preserves partial UTF-8 multi-byte sequences across data chunks', () => {
      const pty = bunTerminalProvider.spawn('sh', [], {});
      const received: string[] = [];
      pty.onData((data) => received.push(data));

      // U+1F600 "GRINNING FACE" is F0 9F 98 80. Split across two chunks.
      const bytes = new Uint8Array([0xf0, 0x9f, 0x98, 0x80]);
      const dataCb = lastSpawn!.options.terminal!.data!;
      dataCb(null, bytes.slice(0, 2));
      dataCb(null, bytes.slice(2));

      // First chunk is incomplete -> decoder buffers it. Second chunk emits
      // the full glyph.
      expect(received.join('')).toBe('\u{1F600}');
    });

    it('PtyProvider interface is satisfied (compile-time check via assignment)', () => {
      const _check: PtyProvider = bunTerminalProvider;
      expect(typeof _check.spawn).toBe('function');
    });
  });
});
