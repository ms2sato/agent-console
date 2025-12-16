import { mock } from 'bun:test';

/**
 * Mock WebSocket for testing.
 * Allows simulating WebSocket events without a real server.
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private static instances: MockWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = mock(() => {});
  close = mock((_code?: number) => {
    this.readyState = MockWebSocket.CLOSED;
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateClose(code: number = 1006, reason: string = '') {
    this.readyState = MockWebSocket.CLOSED;
    // Create a mock CloseEvent since happy-dom may not support code property
    const event = {
      type: 'close',
      code,
      reason,
      wasClean: code === 1000,
    } as CloseEvent;
    this.onclose?.(event);
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  static getInstances(): MockWebSocket[] {
    return MockWebSocket.instances;
  }

  static getLastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }
}

/**
 * Install MockWebSocket as global WebSocket.
 * Returns cleanup function to restore original.
 */
export function installMockWebSocket(): () => void {
  const original = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket;
  MockWebSocket.clearInstances();

  return () => {
    globalThis.WebSocket = original;
  };
}
