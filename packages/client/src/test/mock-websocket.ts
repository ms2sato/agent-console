import { mock } from 'bun:test';
import { WS_CLOSE_CODE, type EmbeddedAgentClientMessage, type WorkerClientMessage } from '@agent-console/shared';

/**
 * Everything an embedded-agent worker's store actually writes to its
 * WebSocket -- the `EmbeddedAgentClientMessage` union plus the two
 * byte-offset/epoch history messages it shares with `WorkerClientMessage`
 * (`request-history`/`request-history-range`, content-agnostic machinery --
 * see `packages/shared/src/types/session.ts`). Mirrors the store's own
 * (unexported) `EmbeddedAgentSendMessage` type in `embedded-agent-store.ts`.
 */
type EmbeddedAgentSentMessage =
  | EmbeddedAgentClientMessage
  | Extract<WorkerClientMessage, { type: 'request-history' | 'request-history-range' }>;

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

  // Typed with a string data param so `send.mock.calls[i][0]` is `string` — the
  // tests always send JSON strings, and this lets callers parse without casts.
  send = mock((_data: string) => {});

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

/** Single writer of the `EmbeddedAgentSentMessage['type']` literal set --
 * mirrors the shared unions in `packages/shared/src/types/session.ts` so a
 * future variant addition there is a one-line update here, not a silent
 * gap. `satisfies` keeps this array in sync with the union at compile time
 * (a typo or a missed variant fails to compile). */
const EMBEDDED_AGENT_SENT_MESSAGE_TYPES = [
  'embedded-user-message',
  'embedded-cancel',
  'embedded-handoff',
  'request-history',
  'request-history-range',
] as const satisfies readonly EmbeddedAgentSentMessage['type'][];

/**
 * Runtime shape guard for `EmbeddedAgentSentMessage` -- checks `type`
 * against the known literals above. There is no valibot schema for this
 * client->server union to reuse (the server parses it manually in
 * `websocket/routes.ts`), so this is a minimal structural check rather than
 * a full schema parse; sufficient for tests that only assert on `type` and
 * pass-through fields (`text`, `clientMessageId`, `fromOffset`).
 */
function isEmbeddedAgentSentMessage(value: unknown): value is EmbeddedAgentSentMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    (EMBEDDED_AGENT_SENT_MESSAGE_TYPES as readonly string[]).includes(value.type)
  );
}

/**
 * Decode one `MockWebSocket.send()` call's JSON payload as an
 * `EmbeddedAgentSentMessage`, asserting its shape at runtime instead of
 * casting through `unknown` (`raw as unknown as T`). Throws on a payload
 * that isn't a recognized message shape, surfacing a malformed test fixture
 * as a loud failure instead of a silently-wrong assertion downstream.
 */
export function decodeSentMessage(raw: string): EmbeddedAgentSentMessage {
  const parsed: unknown = JSON.parse(raw);
  if (!isEmbeddedAgentSentMessage(parsed)) {
    throw new Error(`Not a recognized EmbeddedAgentSentMessage: ${raw}`);
  }
  return parsed;
}

/**
 * Decode every call recorded on a `MockWebSocket.send` mock (`.mock.calls`,
 * shaped `[data: string][]`) as `EmbeddedAgentSentMessage`s, in call order.
 * Replaces the `(ws.send.mock.calls as unknown as string[][])` pattern at
 * embedded-agent test call sites.
 */
export function decodeSentMessages(
  calls: readonly (readonly [string])[],
): EmbeddedAgentSentMessage[] {
  return calls.map(([raw]) => decodeSentMessage(raw));
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
