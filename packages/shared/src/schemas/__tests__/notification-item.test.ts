import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  NotificationItemSchema,
  NotificationsResponseSchema,
  NotificationsSeenRequestSchema,
  NotificationsSeenResponseSchema,
} from '../notification-item.js';
import type {
  NotificationItem,
  NotificationsResponse,
  NotificationsSeenRequest,
  NotificationsSeenResponse,
} from '../../types/notification-item.js';

describe('NotificationItemSchema', () => {
  it('accepts a well-formed NotificationItem object (parse-path, closes the #926 silent-drop gap)', () => {
    // Constructed as the shared `NotificationItem` TS type, then parsed
    // through the wire schema: proves the two are kept in sync
    // (pre-pr-completeness.md Q10). A field added to one but not the other
    // fails this test.
    const item: NotificationItem = {
      kind: 'artifact-created',
      id: 'artifact-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'My Dashboard',
      link: '/artifacts/artifact-1',
    };

    const result = v.safeParse(NotificationItemSchema, item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(item);
    }
  });

  it('accepts a well-formed worktree-deletion-finished item with an outcome', () => {
    const item: NotificationItem = {
      kind: 'worktree-deletion-finished',
      id: 'job-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'Worktree deleted: wt-001',
      link: '/worktree-deletion-tasks/job-1',
      outcome: 'completed',
    };

    const result = v.safeParse(NotificationItemSchema, item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(item);
    }
  });

  it('rejects a missing required field', () => {
    const result = v.safeParse(NotificationItemSchema, {
      kind: 'artifact-created',
      id: 'artifact-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'My Dashboard',
      // link omitted
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid kind value', () => {
    const result = v.safeParse(NotificationItemSchema, {
      kind: 'something-else',
      id: 'artifact-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'My Dashboard',
      link: '/artifacts/artifact-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO occurredAt value', () => {
    const result = v.safeParse(NotificationItemSchema, {
      kind: 'artifact-created',
      id: 'artifact-1',
      occurredAt: 'not-a-timestamp',
      title: 'My Dashboard',
      link: '/artifacts/artifact-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(NotificationItemSchema, {
      kind: 'artifact-created',
      id: 'artifact-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'My Dashboard',
      link: '/artifacts/artifact-1',
      extra: 'field',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('extra');
    }
  });
});

describe('NotificationsResponseSchema', () => {
  it('accepts a well-formed { items, lastSeenAt, unreadCount } response', () => {
    const response: NotificationsResponse = {
      items: [
        {
          kind: 'artifact-created',
          id: 'artifact-1',
          occurredAt: '2026-08-18T00:00:00.000Z',
          title: 'My Dashboard',
          link: '/artifacts/artifact-1',
        },
      ],
      lastSeenAt: '2026-08-17T00:00:00.000Z',
      unreadCount: 1,
    };

    const result = v.safeParse(NotificationsResponseSchema, response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(response);
    }
  });

  it('accepts an empty items array with a null lastSeenAt (boundary case)', () => {
    const response: NotificationsResponse = { items: [], lastSeenAt: null, unreadCount: 0 };
    const result = v.safeParse(NotificationsResponseSchema, response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(response);
    }
  });

  it('rejects a response missing the unreadCount field', () => {
    const result = v.safeParse(NotificationsResponseSchema, { items: [], lastSeenAt: null });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict-parse contract)', () => {
    const result = v.safeParse(NotificationsResponseSchema, {
      items: [],
      lastSeenAt: null,
      unreadCount: 0,
      total: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('total');
    }
  });
});

describe('NotificationsSeenRequestSchema', () => {
  it('accepts a well-formed { lastSeenAt } request', () => {
    const request: NotificationsSeenRequest = { lastSeenAt: '2026-08-18T00:00:00.000Z' };
    const result = v.safeParse(NotificationsSeenRequestSchema, request);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(request);
    }
  });

  it('rejects a missing lastSeenAt field', () => {
    const result = v.safeParse(NotificationsSeenRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(NotificationsSeenRequestSchema, {
      lastSeenAt: '2026-08-18T00:00:00.000Z',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an offset-format ISO timestamp (non-Z timezone offset) -- pins the schema\'s actual accepted range', () => {
    // `v.isoTimestamp()` accepts both `Z`-suffixed and `+HH:mm`/`-HH:mm`
    // offset-suffixed timestamps. This is WHY the route must canonicalize
    // `lastSeenAt` to UTC before it is compared/stored lexically (see
    // routes/notifications.ts's PUT /seen handler and R2 in
    // docs/design/notification-center.md) -- the schema intentionally does
    // NOT narrow this to Z-only, so the normalization responsibility lives
    // at the route, not here.
    const result = v.safeParse(NotificationsSeenRequestSchema, {
      lastSeenAt: '2026-08-18T09:00:00+03:00',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.lastSeenAt).toBe('2026-08-18T09:00:00+03:00');
    }
  });
});

describe('NotificationsSeenResponseSchema', () => {
  it('accepts a well-formed { lastSeenAt } response', () => {
    const response: NotificationsSeenResponse = { lastSeenAt: '2026-08-18T00:00:00.000Z' };
    const result = v.safeParse(NotificationsSeenResponseSchema, response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(response);
    }
  });

  it('rejects a missing lastSeenAt field', () => {
    const result = v.safeParse(NotificationsSeenResponseSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(NotificationsSeenResponseSchema, {
      lastSeenAt: '2026-08-18T00:00:00.000Z',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });
});
