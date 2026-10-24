import { describe, it, expect } from 'bun:test';
import { PTY_NOTIFICATION_KINDS, type PtyNotificationKind } from '@agent-console/shared';
import {
  PAUSE_DISPOSITION,
  DEFERRABLE_NOTIFICATION_KINDS,
  MAX_DEFERRED_NOTIFICATIONS_PER_SESSION,
  type PauseDisposition,
} from '../pause-disposition.js';

// Type pins: every PtyNotificationKind has a row, and no row is extra. `Assert<false>` is a
// TS2344 error, so drift fails `tsc`. Reach (measured with `bun run typecheck`): deleting the
// 'internal-timer' row fails _EveryKindHasARow (TS2344 on that alias) in addition to the table's
// own `satisfies`; adding a 'bogus-kind' row fails _NoExtraRow (TS2344) in addition to the
// excess-property error.
type Assert<T extends true> = T;
type _EveryKindHasARow = Assert<PtyNotificationKind extends keyof typeof PAUSE_DISPOSITION ? true : false>;
type _NoExtraRow = Assert<keyof typeof PAUSE_DISPOSITION extends PtyNotificationKind ? true : false>;
export type _PauseDispositionPins = [_EveryKindHasARow, _NoExtraRow];

describe('PAUSE_DISPOSITION', () => {
  it('has exactly the PTY_NOTIFICATION_KINDS as keys (as a set)', () => {
    expect(new Set(Object.keys(PAUSE_DISPOSITION))).toEqual(new Set(PTY_NOTIFICATION_KINDS));
  });

  it('every value is one of the three dispositions', () => {
    const allowed: PauseDisposition[] = ['defer', 'suspended-at-source', 'live-only'];
    for (const value of Object.values(PAUSE_DISPOSITION)) {
      expect(allowed).toContain(value);
    }
  });

  it('derives the seven deferrable kinds, literally', () => {
    const expected: PtyNotificationKind[] = [
      'inbound-event',
      'internal-message',
      'internal-process',
      'internal-todo-resolved',
      'internal-todo-comment',
      'internal-worker-interrupted',
      'internal-paused-digest',
    ];
    expect([...DEFERRABLE_NOTIFICATION_KINDS].sort()).toEqual(expected.sort());
  });

  it('timers and conditional wakeups are suspended at source, not deferred', () => {
    expect(PAUSE_DISPOSITION['internal-timer']).toBe('suspended-at-source');
    expect(PAUSE_DISPOSITION['internal-conditional-wakeup']).toBe('suspended-at-source');
  });

  it('the three direct-writer kinds are live-only', () => {
    expect(PAUSE_DISPOSITION['internal-review-comment']).toBe('live-only');
    expect(PAUSE_DISPOSITION['internal-reviewed']).toBe('live-only');
    expect(PAUSE_DISPOSITION['internal-agent-spawn-failed']).toBe('live-only');
  });

  it('the per-session cap is 100', () => {
    expect(MAX_DEFERRED_NOTIFICATIONS_PER_SESSION).toBe(100);
  });
});
