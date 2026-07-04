import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { TerminalKeyboardInput } from '../TerminalKeyboardInput';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';

// Fully-typed MediaQueryList stub (no double-cast). The soft-key gate only reads
// `.matches`; the rest of the interface is inert so useIsMobile's subscribe path
// is a no-op under test.
function createMatchMediaList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}

function installMatchMedia(matches: boolean): void {
  window.matchMedia = mock((_query: string) => createMatchMediaList(matches));
}

const SNAPSHOT_STUB: TerminalSnapshot = {
  version: 0,
  status: 'connecting',
  exitInfo: null,
  rows: [],
  cursor: { x: 0, y: 0, visible: true },
  cols: 80,
  terminalRows: 24,
  bufferType: 'normal',
  mouseTracking: false,
  notice: null,
  workerError: null,
  activityState: null,
  loadingHistory: false,
  loadingOlder: false,
  canRequestOlder: false,
  pagedRowCount: 0,
  pagedTopChunkRowCount: 0,
  pagedCapReached: false,
  retentionFloorReached: false,
};

// Render-only stub: TerminalKeyboardInput never subscribes or reads the snapshot
// during render; the methods exist only to satisfy the interface.
function makeMockInstance(): TerminalInstance {
  return {
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT_STUB,
    sendInput: () => {},
    resize: () => {},
    forwardScroll: () => {},
    reportMouseButton: () => {},
    paste: () => {},
    retry: () => {},
    dismissNotice: () => {},
    requestOlderHistory: () => {},
    evictTopChunk: () => {},
    acquire: () => () => {},
    dispose: () => {},
  };
}

describe('TerminalKeyboardInput soft-key bar visibility', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('renders the soft-key bar on mobile', () => {
    installMatchMedia(true);
    render(<TerminalKeyboardInput instance={makeMockInstance()} />);

    expect(screen.getByText('Esc')).toBeTruthy();
    expect(screen.getByText('Ctrl+C')).toBeTruthy();
    // The hidden input path is present on mobile too.
    expect(screen.getByLabelText('Terminal input')).toBeTruthy();
  });

  it('hides the soft-key bar on desktop but keeps the hidden input', () => {
    installMatchMedia(false);
    render(<TerminalKeyboardInput instance={makeMockInstance()} />);

    // No soft keys on desktop.
    expect(screen.queryByText('Esc')).toBeNull();
    expect(screen.queryByText('Ctrl+C')).toBeNull();
    // Input path must remain active so a physical keyboard still works.
    expect(screen.getByLabelText('Terminal input')).toBeTruthy();
  });
});
