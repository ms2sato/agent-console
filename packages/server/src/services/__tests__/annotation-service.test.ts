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
