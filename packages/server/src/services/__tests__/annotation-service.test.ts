import { describe, it, expect, beforeEach } from 'bun:test';
import { AnnotationService } from '../annotation-service.js';
import type { ReviewAnnotationInput } from '@agent-console/shared';

function validInput(overrides?: Partial<ReviewAnnotationInput>): ReviewAnnotationInput {
  return {
    annotations: [
      {
        file: 'src/index.ts',
        startLine: 10,
        endLine: 20,
        reason: 'Complex logic needs review',
      },
    ],
    summary: {
      totalFiles: 5,
      reviewFiles: 2,
      mechanicalFiles: 3,
      confidence: 'high',
    },
    ...overrides,
  };
}

describe('AnnotationService', () => {
  let service: AnnotationService;

  beforeEach(() => {
    service = new AnnotationService();
  });

  describe('setAnnotations', () => {
    it('should store and return annotations with workerId and timestamp', () => {
      const result = service.setAnnotations('worker-1', validInput());

      expect(result.workerId).toBe('worker-1');
      expect(result.annotations).toHaveLength(1);
      expect(result.annotations[0].file).toBe('src/index.ts');
      expect(result.summary.confidence).toBe('high');
      expect(result.createdAt).toBeString();
      // Verify ISO date format
      expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
    });

    it('should overwrite previous annotations for the same worker', () => {
      service.setAnnotations('worker-1', validInput());
      const updated = service.setAnnotations('worker-1', validInput({
        annotations: [
          { file: 'other.ts', startLine: 1, endLine: 5, reason: 'New reason' },
        ],
      }));

      expect(updated.annotations).toHaveLength(1);
      expect(updated.annotations[0].file).toBe('other.ts');
      expect(service.getAnnotations('worker-1')?.annotations[0].file).toBe('other.ts');
    });

    it('should accept empty annotations array', () => {
      const result = service.setAnnotations('worker-1', validInput({
        annotations: [],
        summary: { totalFiles: 3, reviewFiles: 0, mechanicalFiles: 3, confidence: 'high' },
      }));
      expect(result.annotations).toHaveLength(0);
    });

    it('should always set status to pending on creation', () => {
      const result = service.setAnnotations('worker-1', validInput());
      expect(result.status).toBe('pending');
    });

    it('should always set comments to empty array on creation', () => {
      const result = service.setAnnotations('worker-1', validInput());
      expect(result.comments).toEqual([]);
    });

    it('should set sourceSessionId when provided in options', () => {
      const result = service.setAnnotations('worker-1', validInput(), {
        sourceSessionId: 'orchestrator-session',
        sessionId: 'target-session',
      });
      expect(result.sourceSessionId).toBe('orchestrator-session');
    });

    it('should leave sourceSessionId undefined when not provided', () => {
      const result = service.setAnnotations('worker-1', validInput());
      expect(result.sourceSessionId).toBeUndefined();
    });

    it('should store sessionId in metadata when provided', () => {
      service.setAnnotations('worker-1', validInput(), { sessionId: 'sess-1' });
      expect(service.getMetadata('worker-1')).toEqual({ sessionId: 'sess-1' });
    });

    it('should not store metadata when sessionId is not provided', () => {
      service.setAnnotations('worker-1', validInput());
      expect(service.getMetadata('worker-1')).toBeUndefined();
    });

    it('should delete stale metadata when re-setting annotations without sessionId', () => {
      service.setAnnotations('worker-1', validInput(), { sessionId: 'sess-1' });
      expect(service.getMetadata('worker-1')).toEqual({ sessionId: 'sess-1' });

      service.setAnnotations('worker-1', validInput());
      expect(service.getMetadata('worker-1')).toBeUndefined();
    });
  });

  describe('getAnnotations', () => {
    it('should return null for unknown workerId', () => {
      expect(service.getAnnotations('nonexistent')).toBeNull();
    });

    it('should return stored annotations', () => {
      service.setAnnotations('worker-1', validInput());
      const result = service.getAnnotations('worker-1');
      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('worker-1');
    });
  });

  describe('clearAnnotations', () => {
    it('should remove annotations for a worker', () => {
      service.setAnnotations('worker-1', validInput());
      service.clearAnnotations('worker-1');
      expect(service.getAnnotations('worker-1')).toBeNull();
    });

    it('should not throw for unknown workerId', () => {
      expect(() => service.clearAnnotations('nonexistent')).not.toThrow();
    });

    it('should also clear metadata', () => {
      service.setAnnotations('worker-1', validInput(), { sessionId: 'sess-1' });
      service.clearAnnotations('worker-1');
      expect(service.getMetadata('worker-1')).toBeUndefined();
    });
  });

  describe('listReviewQueue', () => {
    it('should return empty array when no review items exist', () => {
      service.setAnnotations('worker-1', validInput());
      const items = service.listReviewQueue(() => undefined);
      expect(items).toEqual([]);
    });

    it('should return only items with sourceSessionId', () => {
      // Regular annotation (not a review queue item)
      service.setAnnotations('worker-1', validInput(), { sessionId: 'sess-1' });
      // Review queue item
      service.setAnnotations('worker-2', validInput(), {
        sessionId: 'sess-2',
        sourceSessionId: 'orchestrator',
      });

      const items = service.listReviewQueue(() => undefined);
      expect(items).toHaveLength(1);
      expect(items[0].workerId).toBe('worker-2');
      expect(items[0].sourceSessionId).toBe('orchestrator');
    });

    it('should use session titles from callback', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const titles: Record<string, string> = {
        'sess-1': 'Worker Session',
        'orchestrator': 'Orchestrator Session',
      };
      const items = service.listReviewQueue((id) => titles[id]);

      expect(items[0].sessionTitle).toBe('Worker Session');
      expect(items[0].sourceSessionTitle).toBe('Orchestrator Session');
    });

    it('should fall back to session ID when title is not available', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const items = service.listReviewQueue(() => undefined);
      expect(items[0].sessionTitle).toBe('sess-1');
      expect(items[0].sourceSessionTitle).toBe('orchestrator');
    });

    it('should include correct annotation and comment counts', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });
      service.addComment('worker-1', { file: 'a.ts', line: 1, body: 'Fix this' });

      const items = service.listReviewQueue(() => undefined);
      expect(items[0].annotationCount).toBe(1);
      expect(items[0].commentCount).toBe(1);
    });
  });

  describe('addComment', () => {
    it('should store comment with generated id and timestamp', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      const comment = service.addComment('worker-1', {
        file: 'src/index.ts',
        line: 15,
        body: 'This needs refactoring',
      });

      expect(comment.id).toBeString();
      expect(comment.id.length).toBeGreaterThan(0);
      expect(comment.file).toBe('src/index.ts');
      expect(comment.line).toBe(15);
      expect(comment.body).toBe('This needs refactoring');
      expect(comment.createdAt).toBeString();
      expect(new Date(comment.createdAt).toISOString()).toBe(comment.createdAt);
    });

    it('should persist comment on the annotation set', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      service.addComment('worker-1', { file: 'a.ts', line: 1, body: 'Comment 1' });
      service.addComment('worker-1', { file: 'b.ts', line: 2, body: 'Comment 2' });

      const annotations = service.getAnnotations('worker-1');
      expect(annotations!.comments).toHaveLength(2);
    });

    it('should throw for unknown worker', () => {
      expect(() =>
        service.addComment('nonexistent', { file: 'a.ts', line: 1, body: 'test' }),
      ).toThrow('No annotations found for worker nonexistent');
    });

    it('should throw for worker without sourceSessionId', () => {
      service.setAnnotations('worker-1', validInput());

      expect(() =>
        service.addComment('worker-1', { file: 'a.ts', line: 1, body: 'test' }),
      ).toThrow('Worker worker-1 is not a review queue item');
    });
  });

  describe('updateStatus', () => {
    it('should change status to completed', () => {
      service.setAnnotations('worker-1', validInput(), {
        sessionId: 'sess-1',
        sourceSessionId: 'orchestrator',
      });

      service.updateStatus('worker-1', 'completed');

      const annotations = service.getAnnotations('worker-1');
      expect(annotations!.status).toBe('completed');
    });

    it('should throw for unknown worker', () => {
      expect(() => service.updateStatus('nonexistent', 'completed')).toThrow(
        'No annotations found for worker nonexistent',
      );
    });

    it('should throw for non-review-queue item', () => {
      service.setAnnotations('worker-1', validInput());

      expect(() => service.updateStatus('worker-1', 'completed')).toThrow(
        'Worker worker-1 is not a review queue item',
      );
    });
  });

  describe('validation', () => {
    it('should reject empty file path', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: '', startLine: 1, endLine: 5, reason: 'reason' }],
        })),
      ).toThrow('file path must be non-empty');
    });

    it('should reject whitespace-only file path', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: '   ', startLine: 1, endLine: 5, reason: 'reason' }],
        })),
      ).toThrow('file path must be non-empty');
    });

    it('should reject startLine < 1', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: 'a.ts', startLine: 0, endLine: 5, reason: 'reason' }],
        })),
      ).toThrow('startLine must be >= 1');
    });

    it('should reject endLine < 1', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: 'a.ts', startLine: 1, endLine: 0, reason: 'reason' }],
        })),
      ).toThrow('endLine must be >= 1');
    });

    it('should reject startLine > endLine', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: 'a.ts', startLine: 10, endLine: 5, reason: 'reason' }],
        })),
      ).toThrow('startLine (10) must be <= endLine (5)');
    });

    it('should reject empty reason', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          annotations: [{ file: 'a.ts', startLine: 1, endLine: 5, reason: '' }],
        })),
      ).toThrow('reason must be non-empty');
    });

    it('should reject totalFiles < reviewFiles + mechanicalFiles', () => {
      expect(() =>
        service.setAnnotations('worker-1', validInput({
          summary: { totalFiles: 3, reviewFiles: 2, mechanicalFiles: 2, confidence: 'high' },
        })),
      ).toThrow('totalFiles (3) must be >= reviewFiles (2) + mechanicalFiles (2)');
    });

    it('should accept totalFiles > reviewFiles + mechanicalFiles', () => {
      const result = service.setAnnotations('worker-1', validInput({
        summary: { totalFiles: 10, reviewFiles: 2, mechanicalFiles: 3, confidence: 'low' },
      }));
      expect(result.summary.totalFiles).toBe(10);
    });

    it('should accept single-line annotation (startLine == endLine)', () => {
      const result = service.setAnnotations('worker-1', validInput({
        annotations: [{ file: 'a.ts', startLine: 5, endLine: 5, reason: 'check this' }],
      }));
      expect(result.annotations[0].startLine).toBe(5);
      expect(result.annotations[0].endLine).toBe(5);
    });
  });
});
