/// <reference path="../../types/bun-terminal.d.ts" />

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { BunTerminalAdapter } from '../bun-terminal-adapter.js';

/**
 * Mock BunTerminal for testing BunTerminalAdapter
 */
function createMockTerminal(): BunTerminal {
  return {
    write: mock(() => {}),
    resize: mock(() => {}),
    close: mock(() => {}),
    closed: false,
  };
}

describe('BunTerminalAdapter', () => {
  describe('exit code calculation', () => {
    // NOTE: Testing _handleExit directly because it's a callback handler
    // called by Bun.spawn internals. We cannot trigger process exit events
    // without spawning real processes, so direct testing is necessary.

    it('should use exitCode when provided', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let capturedEvent: { exitCode: number; signal?: number } | null = null;
      adapter.onExit((event) => {
        capturedEvent = event;
      });

      adapter._handleExit(42, null);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.exitCode).toBe(42);
      expect(capturedEvent!.signal).toBeUndefined();
    });

    it('should calculate 128 + signal when exitCode is null', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let capturedEvent: { exitCode: number; signal?: number } | null = null;
      adapter.onExit((event) => {
        capturedEvent = event;
      });

      // Signal 9 (SIGKILL) should result in exitCode 137 (128 + 9)
      adapter._handleExit(null, 9);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.exitCode).toBe(137);
      expect(capturedEvent!.signal).toBe(9);
    });

    it('should calculate 128 + signal for SIGTERM (signal 15)', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let capturedEvent: { exitCode: number; signal?: number } | null = null;
      adapter.onExit((event) => {
        capturedEvent = event;
      });

      // Signal 15 (SIGTERM) should result in exitCode 143 (128 + 15)
      adapter._handleExit(null, 15);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.exitCode).toBe(143);
      expect(capturedEvent!.signal).toBe(15);
    });

    it('should use -1 when both exitCode and signal are null', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let capturedEvent: { exitCode: number; signal?: number } | null = null;
      adapter.onExit((event) => {
        capturedEvent = event;
      });

      adapter._handleExit(null, null);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.exitCode).toBe(-1);
      expect(capturedEvent!.signal).toBeUndefined();
    });

    it('should prefer exitCode over signal when both are provided', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let capturedEvent: { exitCode: number; signal?: number } | null = null;
      adapter.onExit((event) => {
        capturedEvent = event;
      });

      // When both are provided, exitCode takes precedence
      adapter._handleExit(0, 9);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.exitCode).toBe(0);
      expect(capturedEvent!.signal).toBe(9);
    });
  });

  describe('data handling', () => {
    // NOTE: Testing _handleData directly because it's a callback handler
    // called by Bun.spawn internals when terminal data is received. We cannot
    // trigger data events without spawning real processes, so direct testing is necessary.

    it('should convert Uint8Array to string', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      const receivedDataArray: string[] = [];
      adapter.onData((data) => {
        receivedDataArray.push(data);
      });

      const testData = new TextEncoder().encode('Hello, World!');
      adapter._handleData(testData);

      expect(receivedDataArray).toHaveLength(1);
      expect(receivedDataArray[0]).toBe('Hello, World!');
    });

    it('should handle multi-byte UTF-8 characters', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      const receivedDataArray: string[] = [];
      adapter.onData((data) => {
        receivedDataArray.push(data);
      });

      // Actual multi-byte characters: emoji (4 bytes), Japanese (3 bytes each)
      const testData = new TextEncoder().encode('Hello 👋 世界');
      adapter._handleData(testData);

      expect(receivedDataArray).toHaveLength(1);
      expect(receivedDataArray[0]).toBe('Hello 👋 世界');
    });

    it('should not call callback when no callback is registered', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      // Should not throw when no callback is registered
      const testData = new TextEncoder().encode('test');
      expect(() => adapter._handleData(testData)).not.toThrow();
    });
  });

  describe('callback behavior', () => {
    it('should replace previous onData callback when called multiple times', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let firstCallbackCalled = false;
      const secondCallbackData: string[] = [];

      adapter.onData(() => {
        firstCallbackCalled = true;
      });

      adapter.onData((data) => {
        secondCallbackData.push(data);
      });

      const testData = new TextEncoder().encode('test');
      adapter._handleData(testData);

      expect(firstCallbackCalled).toBe(false);
      expect(secondCallbackData).toHaveLength(1);
      expect(secondCallbackData[0]).toBe('test');
    });

    it('should replace previous onExit callback when called multiple times', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      let firstCallbackCalled = false;
      let secondCallbackEvent: { exitCode: number; signal?: number } | null = null;

      adapter.onExit(() => {
        firstCallbackCalled = true;
      });

      adapter.onExit((event) => {
        secondCallbackEvent = event;
      });

      adapter._handleExit(0, null);

      expect(firstCallbackCalled).toBe(false);
      expect(secondCallbackEvent).not.toBeNull();
      expect(secondCallbackEvent!.exitCode).toBe(0);
    });

    it('should not call onExit callback when no callback is registered', () => {
      const mockTerminal = createMockTerminal();
      const adapter = new BunTerminalAdapter(1234, mockTerminal);

      // Should not throw when no callback is registered
      expect(() => adapter._handleExit(0, null)).not.toThrow();
    });
  });

  describe('terminal delegation', () => {
    let mockTerminal: BunTerminal;
    let adapter: BunTerminalAdapter;

    beforeEach(() => {
      mockTerminal = createMockTerminal();
      adapter = new BunTerminalAdapter(1234, mockTerminal);
    });

    it('should expose pid from constructor', () => {
      expect(adapter.pid).toBe(1234);
    });

    it('should delegate write to terminal.write', () => {
      adapter.write('test input');
      expect(mockTerminal.write).toHaveBeenCalledWith('test input');
    });

    it('should delegate resize to terminal.resize', () => {
      adapter.resize(120, 40);
      expect(mockTerminal.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should delegate kill to terminal.close', () => {
      adapter.kill();
      expect(mockTerminal.close).toHaveBeenCalled();
    });
  });
});
