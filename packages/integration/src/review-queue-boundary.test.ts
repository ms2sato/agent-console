/**
 * Client-Server Boundary Test: Review Queue API
 *
 * Tests that the review queue API correctly enriches ReviewQueueItem
 * with parentSessionId and parentSessionTitle from session parent info.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { Session } from '@agent-console/shared';

// Import test utilities from server package
import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

// Import services
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import type { SessionManager } from '@agent-console/server/src/services/session-manager';

// Import client API function
import { fetchReviewQueue } from '@agent-console/client/src/lib/api';

// Import integration test utilities
import { createFetchBridge } from './test-utils';

/**
 * Create a minimal mock SessionManager with getSession support.
 */
function createMockSessionManager(sessions: Map<string, Session>): SessionManager {
  return {
    getSession: (id: string) => sessions.get(id),
  } as unknown as SessionManager;
}

/**
 * Create a minimal Session object for testing.
 */
function createMockSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    status: 'active',
    locationPath: '/test/path',
    workers: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Client-Server Boundary: Review Queue API', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;
  let annotationService: AnnotationService;

  const parentSessionId = 'parent-session-1';
  const parentSessionTitle = 'Orchestrator Session';
  const childSessionId = 'child-session-1';
  const childSessionTitle = 'Worker Session';
  const sourceSessionId = 'source-session-1';
  const sourceSessionTitle = 'Source Session';
  const workerId = 'worker-1';

  beforeEach(async () => {
    await setupTestEnvironment();

    // Set up sessions: child has a parent
    const sessions = new Map<string, Session>();
    sessions.set(parentSessionId, createMockSession({
      id: parentSessionId,
      title: parentSessionTitle,
    }));
    sessions.set(childSessionId, createMockSession({
      id: childSessionId,
      title: childSessionTitle,
      parentSessionId,
    }));
    sessions.set(sourceSessionId, createMockSession({
      id: sourceSessionId,
      title: sourceSessionTitle,
    }));

    const sessionManager = createMockSessionManager(sessions);
    annotationService = new AnnotationService();

    app = await createTestApp({ sessionManager, annotationService });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
  });

  it('should include parentSessionId and parentSessionTitle when session has a parent', async () => {
    // Create a review queue item: annotations on the child session's worker,
    // sourced from the source session
    annotationService.setAnnotations(
      workerId,
      {
        annotations: [
          {
            file: 'src/index.ts',
            startLine: 1,
            endLine: 10,
            reason: 'Needs review',
          },
        ],
        summary: {
          confidence: 'high',
          totalFiles: 1,
          reviewFiles: 1,
          mechanicalFiles: 0,
        },
      },
      { sessionId: childSessionId, sourceSessionId },
    );

    const groups = await fetchReviewQueue();

    expect(groups).toHaveLength(1);
    expect(groups[0].sourceSessionId).toBe(sourceSessionId);
    expect(groups[0].sourceSessionTitle).toBe(sourceSessionTitle);
    expect(groups[0].items).toHaveLength(1);

    const item = groups[0].items[0];
    expect(item.parentSessionId).toBe(parentSessionId);
    expect(item.parentSessionTitle).toBe(parentSessionTitle);
    expect(item.sessionId).toBe(childSessionId);
    expect(item.sessionTitle).toBe(childSessionTitle);
  });

  it('should omit parentSessionId and parentSessionTitle when session has no parent', async () => {
    // Create a review queue item on a session without a parent
    annotationService.setAnnotations(
      workerId,
      {
        annotations: [
          {
            file: 'src/main.ts',
            startLine: 5,
            endLine: 15,
            reason: 'Check this logic',
          },
        ],
        summary: {
          confidence: 'medium',
          totalFiles: 1,
          reviewFiles: 1,
          mechanicalFiles: 0,
        },
      },
      { sessionId: sourceSessionId, sourceSessionId },
    );

    const groups = await fetchReviewQueue();

    expect(groups).toHaveLength(1);
    const item = groups[0].items[0];
    expect(item.parentSessionId).toBeUndefined();
    expect(item.parentSessionTitle).toBeUndefined();
  });
});
