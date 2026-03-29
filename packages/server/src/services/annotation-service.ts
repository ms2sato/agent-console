import type { ReviewAnnotation, ReviewAnnotationInput, ReviewAnnotationSet } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('annotation-service');

/**
 * In-memory store for diff review annotations, keyed by workerId.
 */
export class AnnotationService {
  private readonly store = new Map<string, ReviewAnnotationSet>();

  /**
   * Validate and store annotations for a worker.
   * Returns the complete ReviewAnnotationSet with workerId and timestamp.
   */
  setAnnotations(workerId: string, data: ReviewAnnotationInput): ReviewAnnotationSet {
    this.validateInput(data);

    const annotationSet: ReviewAnnotationSet = {
      workerId,
      annotations: data.annotations,
      summary: data.summary,
      createdAt: new Date().toISOString(),
    };

    this.store.set(workerId, annotationSet);
    logger.info({ workerId, annotationCount: data.annotations.length }, 'Annotations stored');
    return annotationSet;
  }

  /**
   * Get annotations for a worker, or null if none exist.
   */
  getAnnotations(workerId: string): ReviewAnnotationSet | null {
    return this.store.get(workerId) ?? null;
  }

  /**
   * Remove annotations for a worker.
   */
  clearAnnotations(workerId: string): void {
    this.store.delete(workerId);
    logger.info({ workerId }, 'Annotations cleared');
  }

  private validateInput(data: ReviewAnnotationInput): void {
    // Validate annotations array
    for (const annotation of data.annotations) {
      this.validateAnnotation(annotation);
    }

    // Validate summary
    const { summary } = data;

    if (!['high', 'medium', 'low'].includes(summary.confidence)) {
      throw new Error(`Invalid confidence value: ${summary.confidence}. Must be 'high', 'medium', or 'low'.`);
    }

    if (summary.totalFiles < summary.reviewFiles + summary.mechanicalFiles) {
      throw new Error(
        `totalFiles (${summary.totalFiles}) must be >= reviewFiles (${summary.reviewFiles}) + mechanicalFiles (${summary.mechanicalFiles})`,
      );
    }
  }

  private validateAnnotation(annotation: ReviewAnnotation): void {
    if (!annotation.file || annotation.file.trim() === '') {
      throw new Error('Annotation file path must be non-empty');
    }

    if (annotation.startLine < 1) {
      throw new Error(`startLine must be >= 1, got ${annotation.startLine}`);
    }

    if (annotation.endLine < 1) {
      throw new Error(`endLine must be >= 1, got ${annotation.endLine}`);
    }

    if (annotation.startLine > annotation.endLine) {
      throw new Error(
        `startLine (${annotation.startLine}) must be <= endLine (${annotation.endLine})`,
      );
    }

    if (!annotation.reason || annotation.reason.trim() === '') {
      throw new Error('Annotation reason must be non-empty');
    }
  }
}

export const annotationService = new AnnotationService();
