import { Hono } from 'hono';
import * as v from 'valibot';
import type { ReviewQueueGroup } from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { broadcastToApp } from '../websocket/routes.js';
import { createLogger } from '../lib/logger.js';
import { writePtyNotification } from '../lib/pty-notification.js';

const logger = createLogger('api:review-queue');

// Validation schemas
const AddCommentSchema = v.object({
  file: v.pipe(v.string(), v.minLength(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: v.pipe(v.string(), v.minLength(1)),
});

const UpdateStatusSchema = v.object({
  status: v.literal('completed'),
});

export const reviewQueue = new Hono<AppBindings>()
  .get('/', (c) => {
    const { sessionManager, annotationService } = c.get('appContext');
    const getSessionTitle = (sessionId: string) => sessionManager.getSession(sessionId)?.title;

    const items = annotationService.listReviewQueue(getSessionTitle);

    // Group by sourceSessionId
    const groupMap = new Map<string, ReviewQueueGroup>();
    for (const item of items) {
      let group = groupMap.get(item.sourceSessionId);
      if (!group) {
        group = {
          sourceSessionId: item.sourceSessionId,
          sourceSessionTitle: item.sourceSessionTitle,
          items: [],
        };
        groupMap.set(item.sourceSessionId, group);
      }
      group.items.push(item);
    }

    return c.json(Array.from(groupMap.values()));
  })
  .post('/:workerId/comments', vValidator(AddCommentSchema), async (c) => {
    const workerId = c.req.param('workerId');
    const { sessionManager, annotationService } = c.get('appContext');
    const { file, line, body } = c.req.valid('json');

    const annotationSet = annotationService.getAnnotations(workerId);
    if (!annotationSet) throw new NotFoundError('Annotations');
    if (!annotationSet.sourceSessionId) throw new ValidationError('Worker is not a review queue item');

    const comment = annotationService.addComment(workerId, { file, line, body });

    // Send PTY notification to source session's agent worker (best-effort)
    try {
      const sourceSession = sessionManager.getSession(annotationSet.sourceSessionId);
      if (sourceSession) {
        const agentWorker = sourceSession.workers.find((w) => w.type === 'agent');
        if (agentWorker) {
          const meta = annotationService.getMetadata(workerId);
          const targetSession = meta ? sessionManager.getSession(meta.sessionId) : undefined;
          const targetTitle = targetSession?.title ?? 'Unknown session';

          const writeInput = (data: string) =>
            sessionManager.writeWorkerInput(annotationSet.sourceSessionId!, agentWorker.id, data);

          writePtyNotification({
            kind: 'internal-review-comment',
            tag: 'internal:review-comment',
            fields: {
              session: targetTitle,
              file,
              line: String(line),
              body,
            },
            intent: 'triage',
            writeInput,
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, workerId, sourceSessionId: annotationSet.sourceSessionId },
        'Failed to send comment notification to source session',
      );
    }

    broadcastToApp({ type: 'review-queue-updated' });

    return c.json(comment, 201);
  })
  .patch('/:workerId/status', vValidator(UpdateStatusSchema), (c) => {
    const workerId = c.req.param('workerId');
    const { sessionManager, annotationService } = c.get('appContext');
    const { status } = c.req.valid('json');

    const annotationSet = annotationService.getAnnotations(workerId);
    if (!annotationSet) throw new NotFoundError('Annotations');
    if (!annotationSet.sourceSessionId) throw new ValidationError('Worker is not a review queue item');

    annotationService.updateStatus(workerId, status);

    // Send PTY notification to source session's agent worker (best-effort)
    try {
      const sourceSession = sessionManager.getSession(annotationSet.sourceSessionId);
      if (sourceSession) {
        const agentWorker = sourceSession.workers.find((w) => w.type === 'agent');
        if (agentWorker) {
          const meta = annotationService.getMetadata(workerId);
          const targetSession = meta ? sessionManager.getSession(meta.sessionId) : undefined;
          const targetTitle = targetSession?.title ?? 'Unknown session';

          const writeInput = (data: string) =>
            sessionManager.writeWorkerInput(annotationSet.sourceSessionId!, agentWorker.id, data);

          writePtyNotification({
            kind: 'internal-reviewed',
            tag: 'internal:reviewed',
            fields: {
              session: targetTitle,
              workerId,
              status,
              comments: String(annotationSet.comments.length),
            },
            intent: 'triage',
            writeInput,
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, workerId, sourceSessionId: annotationSet.sourceSessionId },
        'Failed to send reviewed notification to source session',
      );
    }

    broadcastToApp({ type: 'review-queue-updated' });

    return c.json({ workerId, status });
  });
