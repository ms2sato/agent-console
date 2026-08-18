/**
 * Notification center routes (Notification Center Phase 1).
 *
 * Mounted inside the `/api` mount (`routes/api.ts`), AFTER
 * `.use('*', authMiddleware)`, per the same pattern as `routes/artifacts.ts`
 * -- this route relies on that middleware for `authUser` rather than
 * asserting its own auth.
 *
 * `GET /` composes the feed via `NotificationService` (R1 -- read-only,
 * no broadcast). `PUT /seen` does NOT route through the service: R2 says
 * the route talks to the cursor repository directly (the service only
 * READS the cursor, for `GET /`'s `lastSeenAt`).
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { NotificationsSeenRequestSchema } from '@agent-console/shared';
import type { AppBindings } from '../app-context.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Tolerance window for future-timestamp rejection (R2): a future cursor
 * would silently swallow all subsequent notifications forever -- the one
 * non-monotonic footgun the SQL WHERE guard cannot catch (it only compares
 * against the stored value, not against wall-clock "now"). A small
 * tolerance absorbs client/server clock skew without weakening the guard.
 */
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5000;

const notifications = new Hono<AppBindings>()
  .get('/', async (c) => {
    const { notificationService } = c.get('appContext');
    const authUser = c.get('authUser');
    const { items, lastSeenAt, unreadCount } = await notificationService.getFeed({
      userId: authUser.id,
      username: authUser.username,
    });
    return c.json({ items, lastSeenAt, unreadCount });
  })
  .put('/seen', async (c) => {
    const { notificationCursorRepository } = c.get('appContext');
    const authUser = c.get('authUser');

    const rawText = await c.req.text();
    let raw: unknown = {};
    if (rawText.trim() !== '') {
      try {
        raw = JSON.parse(rawText) as unknown;
      } catch {
        throw new ValidationError('Invalid JSON body');
      }
    }

    const parseResult = v.safeParse(NotificationsSeenRequestSchema, raw);
    if (!parseResult.success) {
      const firstIssue = parseResult.issues[0];
      throw new ValidationError(firstIssue?.message ?? 'Validation failed');
    }
    const { lastSeenAt } = parseResult.output;

    // R2: future-timestamp rejection is the route's job -- the SQL WHERE
    // guard in the repository only compares against the stored value, not
    // against wall-clock "now".
    const parsedTime = Date.parse(lastSeenAt);
    if (Number.isNaN(parsedTime) || parsedTime > Date.now() + FUTURE_TIMESTAMP_TOLERANCE_MS) {
      throw new ValidationError('lastSeenAt must not be in the future');
    }

    const current = await notificationCursorRepository.advance(authUser.id, lastSeenAt);
    return c.json({ lastSeenAt: current });
  });

export { notifications };
