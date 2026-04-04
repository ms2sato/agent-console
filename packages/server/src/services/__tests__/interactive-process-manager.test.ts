import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import {
  InteractiveProcessManager,
  MAX_PROCESSES_PER_SESSION,
} from '../interactive-process-manager.js';

describe('InteractiveProcessManager', () => {
  let manager: InteractiveProcessManager;
  let onOutput: ReturnType<typeof mock>;
  let onExit: ReturnType<typeof mock>;
  let mockInjectPtyMessage: ReturnType<typeof mock>;
  let mockWritePtyData: ReturnType<typeof mock>;

  beforeEach(() => {
    onOutput = mock(() => {});
    onExit = mock(() => {});
    mockInjectPtyMessage = mock(() => true);
    mockWritePtyData = mock(() => true);
    manager = new InteractiveProcessManager(onOutput, onExit, {
      injectPtyMessage: mockInjectPtyMessage,
      writePtyData: mockWritePtyData,
    });
  });

  afterEach(() => {
    manager.disposeAll();
  });

  describe('runProcess', () => {
    it('should return InteractiveProcessInfo with correct fields', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'echo hello',
      });

      expect(process.id).toBeString();
      expect(process.id.length).toBeGreaterThan(0);
      expect(process.sessionId).toBe('session-1');
      expect(process.workerId).toBe('worker-1');
      expect(process.command).toBe('echo hello');
      expect(process.status).toBe('running');
      expect(process.startedAt).toBeString();
    });

    it('should throw when session reaches the per-session process limit', async () => {
      for (let i = 0; i < MAX_PROCESSES_PER_SESSION; i++) {
        await manager.runProcess({
          sessionId: 'session-1',
          workerId: 'worker-1',
          command: `sleep 60`,
        });
      }

      expect(
        manager.runProcess({
          sessionId: 'session-1',
          workerId: 'worker-1',
          command: 'sleep 60',
        }),
      ).rejects.toThrow();
    });

    it('should allow processes in different sessions independently', async () => {
      for (let i = 0; i < MAX_PROCESSES_PER_SESSION; i++) {
        await manager.runProcess({
          sessionId: 'session-1',
          workerId: 'worker-1',
          command: 'sleep 60',
        });
      }

      const process = await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });
      expect(process.sessionId).toBe('session-2');
    });

    it('should run process in specified cwd when provided', async () => {
      // Use the real current directory as cwd to avoid memfs/symlink issues in CI
      const cwd = process.cwd();

      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'pwd',
        cwd,
      });

      // Poll until output is received (CI can be slower than 500ms)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (onOutput.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(onOutput).toHaveBeenCalled();
      const [, output] = onOutput.mock.calls[0];
      expect(output.trim()).toBe(cwd);
    });

    it('should call onOutput when process writes to stdout', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'echo "test output"',
      });

      // Wait for the process to produce output
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(onOutput).toHaveBeenCalled();
      const [, output] = onOutput.mock.calls[0];
      expect(output).toContain('test output');
    });

    it('should call onExit when process terminates', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'echo done',
      });

      // Wait for the process to exit
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(onExit).toHaveBeenCalled();
      const [exitInfo] = onExit.mock.calls[0];
      expect(exitInfo.status).toBe('exited');
      expect(exitInfo.exitCode).toBe(0);
    });

    it('should detect exit when a stdin-reading script calls process.exit(0)', async () => {
      // Simulates the fix for #546: a script that reads from stdin via async iterator
      // must call process.exit(0) after completing work, otherwise stdin keeps it alive.
      const script = `
        const iter = process.stdin[Symbol.asyncIterator]();
        const { value } = await iter.next();
        const input = Buffer.from(value).toString().replace('\\0', '').trim();
        console.log('received: ' + input);
        process.exit(0);
      `;
      const processInfo = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: `bun -e "${script.replace(/"/g, '\\"')}"`,
      });

      // Send input to unblock the script
      await new Promise((resolve) => setTimeout(resolve, 200));
      await manager.writeResponse(processInfo.id, 'test-input');

      // Wait for exit
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (onExit.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(onExit).toHaveBeenCalled();
      const [exitInfo] = onExit.mock.calls[0];
      expect(exitInfo.status).toBe('exited');
      expect(exitInfo.exitCode).toBe(0);
    });

  });

  describe('killProcess', () => {
    it('should return true and remove an existing process', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });

      const result = manager.killProcess(process.id);
      expect(result).toBe(true);
      expect(manager.getProcess(process.id)).toBeUndefined();
    });

    it('should return false for a non-existent process', () => {
      const result = manager.killProcess('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('getProcess', () => {
    it('should return InteractiveProcessInfo for an existing process', async () => {
      const created = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });

      const retrieved = manager.getProcess(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.command).toBe('sleep 60');
    });

    it('should return undefined for a non-existent process', () => {
      expect(manager.getProcess('does-not-exist')).toBeUndefined();
    });
  });

  describe('listProcesses', () => {
    it('should list all processes when no sessionId filter is provided', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });

      const all = manager.listProcesses();
      expect(all).toHaveLength(2);
    });

    it('should filter by sessionId when provided', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 61',
      });

      const session1Processes = manager.listProcesses('session-1');
      expect(session1Processes).toHaveLength(2);
      expect(session1Processes.every((p) => p.sessionId === 'session-1')).toBe(true);
    });

    it('should return an empty array when no processes exist', () => {
      expect(manager.listProcesses()).toEqual([]);
    });

    it('should return an empty array when filtering by a session with no processes', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });

      expect(manager.listProcesses('session-other')).toEqual([]);
    });
  });

  describe('deleteProcessesBySession', () => {
    it('should delete all processes for a session and return the count', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 61',
      });
      await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });

      const deleted = manager.deleteProcessesBySession('session-1');
      expect(deleted).toBe(2);
      expect(manager.listProcesses('session-1')).toEqual([]);
    });

    it('should return 0 for a session with no processes', () => {
      expect(manager.deleteProcessesBySession('no-such-session')).toBe(0);
    });

    it('should not affect other sessions', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });

      manager.deleteProcessesBySession('session-1');

      const remaining = manager.listProcesses();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('session-2');
    });
  });

  describe('disposeAll', () => {
    it('should clear all processes', async () => {
      await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });
      await manager.runProcess({
        sessionId: 'session-2',
        workerId: 'worker-2',
        command: 'sleep 60',
      });

      manager.disposeAll();

      expect(manager.listProcesses()).toEqual([]);
    });
  });

  describe('writeResponse', () => {
    it('should return false for a non-existent process', async () => {
      const result = await manager.writeResponse('non-existent', 'content');
      expect(result).toBe(false);
    });

    it('should return false for a killed process', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'sleep 60',
      });

      manager.killProcess(process.id);

      const result = await manager.writeResponse(process.id, 'content');
      expect(result).toBe(false);
    });

    it('should return true when writing to a running process', async () => {
      // Use a long-running process that stays alive to accept stdin
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'cat > /dev/null',
      });

      // Poll until writeResponse succeeds (process may need time to start)
      const deadline = Date.now() + 5000;
      let result = false;
      while (Date.now() < deadline) {
        const info = manager.getProcess(process.id);
        if (info?.status === 'running') {
          result = await manager.writeResponse(process.id, 'hello world');
          if (result) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(result).toBe(true);
    });

    it('should call writePtyData with CR-converted content on successful write', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'cat > /dev/null',
      });

      const deadline = Date.now() + 5000;
      let result = false;
      while (Date.now() < deadline) {
        const info = manager.getProcess(process.id);
        if (info?.status === 'running') {
          result = await manager.writeResponse(process.id, 'hello');
          if (result) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(result).toBe(true);
      expect(mockWritePtyData).toHaveBeenCalledWith('session-1', 'worker-1', 'hello');
      // injectPtyMessage should NOT be called for writeResponse path
      expect(mockInjectPtyMessage).not.toHaveBeenCalled();
    });

    it('should not call writePtyData when ptyMessageInjector is not provided', async () => {
      const managerNoPty = new InteractiveProcessManager(onOutput, onExit);
      const process = await managerNoPty.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'cat > /dev/null',
      });

      const deadline = Date.now() + 5000;
      let result = false;
      while (Date.now() < deadline) {
        const info = managerNoPty.getProcess(process.id);
        if (info?.status === 'running') {
          result = await managerNoPty.writeResponse(process.id, 'hello');
          if (result) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(result).toBe(true);
      expect(mockWritePtyData).not.toHaveBeenCalled();
      managerNoPty.disposeAll();
    });
  });

  describe('debounced Enter for writeResponse', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should send \\r after DEBOUNCE_ENTER_MS when no process output arrives', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'cat > /dev/null',
      });

      // Wait for process to start
      jest.useRealTimers();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (manager.getProcess(process.id)?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      jest.useFakeTimers();

      await manager.writeResponse(process.id, 'hello');

      // Content should be written immediately
      expect(mockWritePtyData).toHaveBeenCalledWith('session-1', 'worker-1', 'hello');

      // \r should not be sent yet
      const callsBefore = mockWritePtyData.mock.calls.length;

      // Advance past debounce
      jest.advanceTimersByTime(InteractiveProcessManager.DEBOUNCE_ENTER_MS);

      // \r should now be sent
      expect(mockWritePtyData).toHaveBeenCalledTimes(callsBefore + 1);
      expect(mockWritePtyData.mock.calls[callsBefore]).toEqual(['session-1', 'worker-1', '\r']);
    });

    it('should not send \\r for a killed process', async () => {
      const process = await manager.runProcess({
        sessionId: 'session-1',
        workerId: 'worker-1',
        command: 'cat > /dev/null',
      });

      jest.useRealTimers();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (manager.getProcess(process.id)?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      jest.useFakeTimers();

      await manager.writeResponse(process.id, 'hello');
      const callsAfterContent = mockWritePtyData.mock.calls.length;

      // Kill before debounce fires
      manager.killProcess(process.id);

      jest.advanceTimersByTime(InteractiveProcessManager.DEBOUNCE_ENTER_MS);

      // No \r should be sent
      expect(mockWritePtyData).toHaveBeenCalledTimes(callsAfterContent);
    });
  });
});
