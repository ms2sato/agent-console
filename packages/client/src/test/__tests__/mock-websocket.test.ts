import { describe, expect, test } from 'bun:test';
import { decodeSentMessage } from '../mock-websocket';

describe('decodeSentMessage', () => {
  test('accepts a well-formed embedded-user-message payload', () => {
    const raw = JSON.stringify({ type: 'embedded-user-message', text: 'hello' });
    expect(decodeSentMessage(raw)).toEqual({ type: 'embedded-user-message', text: 'hello' });
  });

  test('accepts a well-formed request-history-range payload', () => {
    const raw = JSON.stringify({
      type: 'request-history-range',
      requestId: 1,
      beforeOffset: 42,
    });
    expect(decodeSentMessage(raw)).toEqual({
      type: 'request-history-range',
      requestId: 1,
      beforeOffset: 42,
    });
  });

  test('rejects a payload with a valid type but a missing required field', () => {
    const raw = JSON.stringify({ type: 'embedded-user-message' });
    expect(() => decodeSentMessage(raw)).toThrow(/Not a recognized EmbeddedAgentSentMessage/);
  });

  test('rejects a payload with a valid type but a wrong-typed required field', () => {
    const raw = JSON.stringify({ type: 'embedded-user-message', text: 42 });
    expect(() => decodeSentMessage(raw)).toThrow(/Not a recognized EmbeddedAgentSentMessage/);
  });

  test('rejects a request-history-range payload missing beforeOffset', () => {
    const raw = JSON.stringify({ type: 'request-history-range', requestId: 1 });
    expect(() => decodeSentMessage(raw)).toThrow(/Not a recognized EmbeddedAgentSentMessage/);
  });

  test('rejects a payload with an unrecognized type', () => {
    const raw = JSON.stringify({ type: 'not-a-real-type' });
    expect(() => decodeSentMessage(raw)).toThrow(/Not a recognized EmbeddedAgentSentMessage/);
  });
});
