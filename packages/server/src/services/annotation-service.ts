import type {
  ReviewAnnotation,
  ReviewAnnotationInput,
  ReviewAnnotationSet,
  ReviewComment,
  ReviewQueueItem,
  ReviewStatus,
} from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('annotation-service');

/** Options for setAnnotations controlling review queue behavior. */
export type SetAnnotationsOptions =
  | {
      /** The session ID that owns the worker. Stored as internal metadata for review queue lookups. */
      sessionId: string;
      /** Source session that requested the review (e.g., orchestrator). When set, the annotation becomes a review queue item. */
      sourceSessionId: string;
    }
  | {
      /** The session ID that owns the worker. Optional for non-queue annotation writes. */
      sessionId?: string;
      sourceSessionId?: undefined;
    };

/**
 * In-memory store for diff review annotations, keyed by workerId.
 */
export class AnnotationService {
  private readonly store = new Map<string, ReviewAnnotationSet>();
  /** Internal metadata not exposed in the annotation set type (e.g., owning sessionId). */
  private readonly metadata = new Map<string, { sessionId: string }>();

  /**
   * Validate and store annotations for a worker.
   * Returns the complete ReviewAnnotationSet with workerId and timestamp.
   */
  setAnnotations(
    workerId: string,
    data: ReviewAnnotationInput,
    options?: SetAnnotationsOptions,
  ): ReviewAnnotationSet {
    this.validateInput(data);

    const annotationSet: ReviewAnnotationSet = {
      workerId,
      annotations: data.annotations,
      summary: data.summary,
      createdAt: new Date().toISOString(),
      sourceSessionId: options?.sourceSessionId,
      status: 'pending',
      comments: [],
    };

    this.store.set(workerId, annotationSet);
    if (options?.sessionId) {
      this.metadata.set(workerId, { sessionId: options.sessionId });
    } else {
      this.metadata.delete(workerId);
    }
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
   * Get internal metadata for a worker (e.g., owning sessionId).
   */
  getMetadata(workerId: string): { sessionId: string } | undefined {
    return this.metadata.get(workerId);
  }

  /**
   * Remove annotations and associated metadata for a worker.
   */
  clearAnnotations(workerId: string): void {
    this.store.delete(workerId);
    this.metadata.delete(workerId);
    logger.info({ workerId }, 'Annotations cleared');
  }

  /**
   * List all annotation sets that are review queue items (have sourceSessionId).
   * @param getSessionTitle - Callback to look up session titles by ID.
   */
  listReviewQueue(getSessionTitle: (sessionId: string) => string | undefined): ReviewQueueItem[] {
    const items: ReviewQueueItem[] = [];
    for (const [workerId, annotationSet] of this.store) {
      if (!annotationSet.sourceSessionId) continue;
      if (annotationSet.status !== 'pending') continue;
      const meta = this.metadata.get(workerId);
      if (!meta) continue;
      items.push({
        workerId,
        sessionId: meta.sessionId,
        sessionTitle: getSessionTitle(meta.sessionId) ?? meta.sessionId,
        sourceSessionId: annotationSet.sourceSessionId,
        sourceSessionTitle: getSessionTitle(annotationSet.sourceSessionId) ?? annotationSet.sourceSessionId,
        annotationCount: annotationSet.annotations.length,
        summary: annotationSet.summary,
        status: annotationSet.status,
        commentCount: annotationSet.comments.length,
        createdAt: annotationSet.createdAt,
      });
    }
    return items;
  }

  /**
   * Add an inline review comment to a review queue item.
   * @throws If no annotations exist for the worker or it is not a review queue item.
   */
  addComment(workerId: string, comment: { file: string; line: number; body: string }): ReviewComment {
    const annotationSet = this.store.get(workerId);
    if (!annotationSet) {
      throw new Error(`No annotations found for worker ${workerId}`);
    }
    if (!annotationSet.sourceSessionId) {
      throw new Error(`Worker ${workerId} is not a review queue item`);
    }

    const reviewComment: ReviewComment = {
      id: crypto.randomUUID(),
      file: comment.file,
      line: comment.line,
      body: comment.body,
      createdAt: new Date().toISOString(),
    };
    annotationSet.comments.push(reviewComment);
    return reviewComment;
  }

  /**
   * Update the review status of a review queue item.
   * @throws If no annotations exist for the worker or it is not a review queue item.
   */
  updateStatus(workerId: string, status: ReviewStatus): void {
    const annotationSet = this.store.get(workerId);
    if (!annotationSet) {
      throw new Error(`No annotations found for worker ${workerId}`);
    }
    if (!annotationSet.sourceSessionId) {
      throw new Error(`Worker ${workerId} is not a review queue item`);
    }
    annotationSet.status = status;
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
