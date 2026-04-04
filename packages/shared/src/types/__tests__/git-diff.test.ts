import { describe, it, expect } from 'bun:test';
import type { ReviewQueueItem } from '../git-diff.js';

describe('ReviewQueueItem', () => {
  const baseItem: ReviewQueueItem = {
    workerId: 'w1',
    sessionId: 's1',
    sessionTitle: 'Session 1',
    sourceSessionId: 'src1',
    sourceSessionTitle: 'Source 1',
    annotationCount: 1,
    summary: { totalFiles: 1, reviewFiles: 1, mechanicalFiles: 0, confidence: 'high' },
    status: 'pending',
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('should allow parentSessionId and parentSessionTitle fields', () => {
    const item: ReviewQueueItem = {
      ...baseItem,
      parentSessionId: 'parent1',
      parentSessionTitle: 'Parent Session',
    };
    expect(item.parentSessionId).toBe('parent1');
    expect(item.parentSessionTitle).toBe('Parent Session');
  });

  it('should allow omitting parentSessionId and parentSessionTitle', () => {
    const item: ReviewQueueItem = { ...baseItem };
    expect(item.parentSessionId).toBeUndefined();
    expect(item.parentSessionTitle).toBeUndefined();
  });
});
