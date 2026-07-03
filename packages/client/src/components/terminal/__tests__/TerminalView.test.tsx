import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
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
