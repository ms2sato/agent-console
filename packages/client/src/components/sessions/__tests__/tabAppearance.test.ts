import { describe, it, expect } from 'bun:test';
import type { Worker } from '@agent-console/shared';
import { getTabDotColor, isCloseableTabType, getWorkerTypeLabel, showsActivityBadge } from '../tabAppearance';

describe('getTabDotColor', () => {
  it('returns blue for agent workers', () => {
    expect(getTabDotColor('agent')).toBe('bg-blue-500');
  });

  it('returns purple for embedded-agent workers', () => {
    expect(getTabDotColor('embedded-agent')).toBe('bg-purple-500');
  });

  it('returns green for terminal workers', () => {
    expect(getTabDotColor('terminal')).toBe('bg-green-500');
  });

  it('returns green for git-diff workers (defensive default; caller renders an icon instead)', () => {
    expect(getTabDotColor('git-diff')).toBe('bg-green-500');
  });

  it('covers every Worker type without falling through to the exhaustive guard', () => {
    const allTypes: Worker['type'][] = ['agent', 'terminal', 'git-diff', 'embedded-agent'];
    for (const type of allTypes) {
      expect(() => getTabDotColor(type)).not.toThrow();
    }
  });
});

describe('isCloseableTabType', () => {
  it('terminal tabs are closeable', () => {
    expect(isCloseableTabType('terminal')).toBe(true);
  });

  it('embedded-agent tabs are closeable', () => {
    expect(isCloseableTabType('embedded-agent')).toBe(true);
  });

  it('agent tabs are fixed (not closeable)', () => {
    expect(isCloseableTabType('agent')).toBe(false);
  });

  it('git-diff tabs are fixed (not closeable)', () => {
    expect(isCloseableTabType('git-diff')).toBe(false);
  });
});

describe('getWorkerTypeLabel', () => {
  it('labels each worker type used by WorkerErrorFallback', () => {
    expect(getWorkerTypeLabel('git-diff')).toBe('Diff View');
    expect(getWorkerTypeLabel('agent')).toBe('Agent');
    expect(getWorkerTypeLabel('terminal')).toBe('Terminal');
    expect(getWorkerTypeLabel('embedded-agent')).toBe('Embedded Agent');
  });
});

describe('showsActivityBadge', () => {
  it('shows the badge for agent tabs', () => {
    expect(showsActivityBadge('agent')).toBe(true);
  });

  it('shows the badge for embedded-agent tabs (unified with the shared status bar)', () => {
    expect(showsActivityBadge('embedded-agent')).toBe(true);
  });

  it('hides the badge for terminal tabs', () => {
    expect(showsActivityBadge('terminal')).toBe(false);
  });

  it('hides the badge for git-diff tabs', () => {
    expect(showsActivityBadge('git-diff')).toBe(false);
  });
});
