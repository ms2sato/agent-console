import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { DiffViewer } from '../DiffViewer';
import type { GitDiffFile } from '@agent-console/shared';

// happy-dom does not provide IntersectionObserver, which DiffViewer constructs in an effect.
beforeAll(() => {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

const longPath = `https://example.com/${'a'.repeat(180)}`;

describe('DiffViewer', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the file-header path span with break-all and min-w-0 so long paths wrap', () => {
    const file: GitDiffFile = {
      path: longPath,
      status: 'added',
      stageState: 'unstaged',
      additions: 1,
      deletions: 0,
      isBinary: false,
    };

    render(<DiffViewer rawDiff="" files={[file]} scrollToFile={null} />);

    // The file-header span carries `font-medium` and renders the full path.
    const span = screen.getByText(longPath);
    expect(span.className).toContain('font-medium');
    expect(span.className).toContain('break-all');
    expect(span.className).toContain('min-w-0');
  });
});
