import { describe, it, expect, beforeEach } from 'bun:test';
import type { AgentActivityState } from '@agent-console/shared';
import { updateFavicon, hasAnyAskingWorker } from '../favicon-manager';

describe('updateFavicon', () => {
  beforeEach(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = '';
    // Reset module-level cached state to a known baseline
    updateFavicon(false);
  });

  it('sets favicon to waiting when hasAskingWorker is true', () => {
    updateFavicon(true);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link?.href).toContain('/favicon-waiting.svg');
  });

  it('sets favicon to normal when hasAskingWorker is false', () => {
    // First set to waiting so the transition actually happens
    updateFavicon(true);

    updateFavicon(false);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link?.href).toContain('/favicon.svg');
    expect(link?.href).not.toContain('waiting');
  });

  it('does not update DOM when favicon already matches', () => {
    updateFavicon(true);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const hrefAfterFirstCall = link?.href;

    // Mutate href to a sentinel value so we can detect if it gets overwritten
    link!.href = '/sentinel.svg';

    // Call again with same state - should skip due to cached path
    updateFavicon(true);

    expect(link?.href).toContain('/sentinel.svg');
    expect(link?.href).not.toBe(hrefAfterFirstCall);
  });

  it('does nothing if no link[rel="icon"] element exists', () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    link?.remove();

    // Should not throw
    expect(() => updateFavicon(true)).not.toThrow();
  });
});

describe('hasAnyAskingWorker', () => {
  it('returns false for empty object', () => {
    expect(hasAnyAskingWorker({})).toBe(false);
  });

  it('returns false when no workers are asking', () => {
    const states: Record<string, Record<string, AgentActivityState>> = {
      session1: {
        worker1: 'idle',
        worker2: 'active',
      },
    };
    expect(hasAnyAskingWorker(states)).toBe(false);
  });

  it('returns true when one worker is asking', () => {
    const states: Record<string, Record<string, AgentActivityState>> = {
      session1: {
        worker1: 'asking',
      },
    };
    expect(hasAnyAskingWorker(states)).toBe(true);
  });

  it('returns true when asking worker is in a different session', () => {
    const states: Record<string, Record<string, AgentActivityState>> = {
      session1: {
        worker1: 'idle',
      },
      session2: {
        worker1: 'asking',
      },
    };
    expect(hasAnyAskingWorker(states)).toBe(true);
  });

  it('returns false for other activity states', () => {
    const nonAskingStates: AgentActivityState[] = ['idle', 'active', 'unknown'];
    for (const state of nonAskingStates) {
      const states: Record<string, Record<string, AgentActivityState>> = {
        session1: { worker1: state },
      };
      expect(hasAnyAskingWorker(states)).toBe(false);
    }
  });

  it('detects asking among multiple sessions and workers', () => {
    const states: Record<string, Record<string, AgentActivityState>> = {
      session1: {
        worker1: 'idle',
        worker2: 'active',
      },
      session2: {
        worker1: 'unknown',
        worker2: 'idle',
      },
      session3: {
        worker1: 'asking',
      },
    };
    expect(hasAnyAskingWorker(states)).toBe(true);
  });
});
