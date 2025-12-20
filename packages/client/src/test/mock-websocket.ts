import { mock } from 'bun:test';
import { WS_CLOSE_CODE } from '@agent-console/shared';

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

  /**
   * Mock close method with browser-compatible validation.
   *
   * Browser WebSocket API restricts close codes to:
   * - 1000 (NORMAL_CLOSURE)
   * - 3000-4999 (application-defined)
   *
   * Codes like 1001 (GOING_AWAY) are valid in the WebSocket protocol
   * but cannot be sent from browser-side JavaScript.
   * This validation ensures tests catch such issues before manual testing.
   */
  close = mock((code?: number) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(
        `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
        'InvalidAccessError'
      );
    }
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

  /**
   * Simulate WebSocket entering CLOSING state.
   * Use this to test behavior when socket is in the process of closing.
   */
  simulateClosing() {
    this.readyState = MockWebSocket.CLOSING;
  }

  /**
   * Simulate WebSocket close event.
   * @param code Close code (default: ABNORMAL_CLOSURE)
   * @param reason Close reason string
   */
  simulateClose(code: number = WS_CLOSE_CODE.ABNORMAL_CLOSURE, reason: string = '') {
    this.readyState = MockWebSocket.CLOSED;
    // Create a mock CloseEvent since happy-dom may not support code property
    const event = {
      type: 'close',
      code,
      reason,
      wasClean: code === WS_CLOSE_CODE.NORMAL_CLOSURE,
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
