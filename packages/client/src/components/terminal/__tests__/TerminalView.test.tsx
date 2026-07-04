import { describe, it, expect, afterEach, mock } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TerminalView } from '../TerminalView';
import type { TerminalInstance, TerminalSnapshot } from '../terminal-store';
import type { TerminalRow } from '../buffer-to-rows';

// A fixed snapshot exercising the renderer's core row contract: a plain segment,
// a styled segment (bold + fg color), and a decorator-attached link segment.
const ROWS: TerminalRow[] = [
  {
    key: 0,
    isWrapped: false,
    links: [],
    segments: [
      { text: 'hello ', style: null },
      { text: 'world', style: { bold: true, fg: '#ff0000' } },
    ],
  },
  {
    key: 1,
    isWrapped: false,
    links: [],
    segments: [
      { text: 'see ', style: null },
      { text: '#123', style: null, link: { href: 'https://github.com/acme/widgets/issues/123' } },
    ],
  },
];

function makeSnapshot(rows: TerminalRow[]): TerminalSnapshot {
  return {
    version: 1,
    status: 'connected',
    exitInfo: null,
    rows,
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
  };
}

// Stub instance backed by a fixed snapshot (stable reference so
// useSyncExternalStore does not loop). The view only reads the snapshot.
function makeInstance(snapshot: TerminalSnapshot): TerminalInstance {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
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

describe('TerminalView row rendering', () => {
  afterEach(cleanup);

  it('renders each row segment as text', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('world')).toBeTruthy();
    expect(screen.getByText('see')).toBeTruthy();
  });

  it('applies a segment style (bold + foreground color) to the styled span', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    const styled = screen.getByText('world');
    expect(styled.style.fontWeight).toBe('bold');
    // happy-dom may serialize the hex as rgb(); accept either representation.
    const styleAttr = styled.getAttribute('style') ?? '';
    expect(styleAttr.includes('255, 0, 0') || styleAttr.toLowerCase().includes('ff0000')).toBe(true);
  });

  it('renders a link segment as an anchor with href, target and rel', () => {
    render(<TerminalView instance={makeInstance(makeSnapshot(ROWS))} />);

    const link = screen.getByText('#123');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/123');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

// Layout-dependent geometry (scrollTop / clientHeight) is not produced by
// happy-dom, so these tests define it explicitly on the scroll container. The
// precise anchor-rect physics are verified by the coordinator's E2E; here we
// assert only the trigger wiring: scroll-at-top + canRequestOlder -> the store
// method fires, and the gate holds when the store says paging is not allowed.
describe('TerminalView history-paging trigger', () => {
  afterEach(cleanup);

  function setGeometry(el: HTMLElement, scrollTop: number) {
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  }

  it('requests older history when scrolled near the top and paging is allowed', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: true };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 50); // 50 < 2 * clientHeight (200) -> near the top
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).toHaveBeenCalled();
  });

  it('does not request older history when the store disallows it', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: false };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 50);
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('does not request older history when scrolled far from the top', () => {
    const requestOlderHistory = mock(() => {});
    const snapshot = { ...makeSnapshot(ROWS), canRequestOlder: true };
    const instance = { ...makeInstance(snapshot), requestOlderHistory };
    const { container } = render(<TerminalView instance={instance} />);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    setGeometry(scroller, 500); // 500 >= 200 -> not near the top
    fireEvent.scroll(scroller);
    expect(requestOlderHistory).not.toHaveBeenCalled();
  });

  it('shows the cap-reached notice overlay', () => {
    const snapshot = { ...makeSnapshot(ROWS), pagedCapReached: true };
    render(<TerminalView instance={makeInstance(snapshot)} />);
    expect(screen.getByText(/older history paused/i)).toBeTruthy();
  });
});
