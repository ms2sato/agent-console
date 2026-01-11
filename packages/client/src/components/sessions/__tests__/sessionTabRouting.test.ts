import { describe, it, expect } from 'bun:test';
import { getDefaultTabId, isWorkerIdReady, type TabLike } from '../sessionTabRouting';

const buildTabs = (): TabLike[] => ([
  { id: 'agent-1', workerType: 'agent' },
  { id: 'term-1', workerType: 'terminal' },
]);

describe('sessionTabRouting', () => {
  describe('isWorkerIdReady', () => {
    it('returns true when urlWorkerId is already in tabs', () => {
      expect(isWorkerIdReady('term-1', buildTabs(), null)).toBe(true);
    });

    it('returns true when urlWorkerId matches pendingWorkerId', () => {
      expect(isWorkerIdReady('term-2', buildTabs(), 'term-2')).toBe(true);
    });

    it('returns false when urlWorkerId is unknown and not pending', () => {
      expect(isWorkerIdReady('unknown', buildTabs(), null)).toBe(false);
    });
  });

  describe('getDefaultTabId', () => {
    it('returns first agent tab when available', () => {
      expect(getDefaultTabId(buildTabs())).toBe('agent-1');
    });

    it('falls back to first tab when no agent tab exists', () => {
      expect(getDefaultTabId([{ id: 'term-1', workerType: 'terminal' }])).toBe('term-1');
    });

    it('returns null when tabs are empty', () => {
      expect(getDefaultTabId([])).toBe(null);
    });
  });
});
