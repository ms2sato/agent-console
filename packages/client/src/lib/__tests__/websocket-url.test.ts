import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getWsProtocol, getAppWsUrl, getWorkerWsUrl } from '../websocket-url';

function setLocation(protocol: string, host: string) {
  Object.defineProperty(window, 'location', {
    value: { protocol, host },
    writable: true,
  });
}

describe('getWsProtocol', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('returns ws: for http: protocol', () => {
    setLocation('http:', 'localhost:3000');
    expect(getWsProtocol()).toBe('ws:');
  });

  it('returns wss: for https: protocol', () => {
    setLocation('https:', 'example.com');
    expect(getWsProtocol()).toBe('wss:');
  });
});

describe('getAppWsUrl', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('returns correct URL with ws: for http page', () => {
    setLocation('http:', 'localhost:3000');
    expect(getAppWsUrl()).toBe('ws://localhost:3000/ws/app');
  });

  it('returns correct URL with wss: for https page', () => {
    setLocation('https:', 'example.com');
    expect(getAppWsUrl()).toBe('wss://example.com/ws/app');
  });

  it('includes the host from window.location', () => {
    setLocation('http:', 'myhost:8080');
    expect(getAppWsUrl()).toBe('ws://myhost:8080/ws/app');
  });
});

describe('getWorkerWsUrl', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    setLocation('http:', 'localhost:3000');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('returns correct URL without fromOffset', () => {
    expect(getWorkerWsUrl('session-1', 'worker-1')).toBe(
      'ws://localhost:3000/ws/session/session-1/worker/worker-1'
    );
  });

  it('returns correct URL with fromOffset query parameter', () => {
    expect(getWorkerWsUrl('session-1', 'worker-1', 42)).toBe(
      'ws://localhost:3000/ws/session/session-1/worker/worker-1?fromOffset=42'
    );
  });

  it('includes fromOffset of 0 (not treated as falsy)', () => {
    expect(getWorkerWsUrl('session-1', 'worker-1', 0)).toBe(
      'ws://localhost:3000/ws/session/session-1/worker/worker-1?fromOffset=0'
    );
  });

  it('correctly places sessionId and workerId in path', () => {
    const url = getWorkerWsUrl('abc-123', 'def-456');
    expect(url).toContain('/ws/session/abc-123/worker/def-456');
  });
});
