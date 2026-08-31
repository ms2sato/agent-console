import { describe, it, expect } from 'bun:test';
import type { NotificationEvent, OutboundTriggerEventType } from '../notification';

// -----------------------------------------------------------------------
// Type-level compile pin: `NotificationEvent['type']` and
// `OutboundTriggerEventType` stay in bidirectional parity. Per
// `.claude/rules/workflow.md`'s "pins include type-level assertions"
// section, a pin using `never` as the constraint is inert (`declare const
// x: never` type-checks even when the asserted condition is false, because
// `declare` introduces no assignment for `never` to reject). This uses
// `Assert<T extends true>` instead, which genuinely fails `tsc` when the
// condition is false -- same idiom as `../notification.ts`,
// `packages/shared/src/types/__tests__/session.test.ts`'s `RestoreInfo`
// pin, and `packages/shared/src/schemas/embedded-agent.ts`.
//
// No runtime observable exists for this fact: `OutboundTriggerEventType`
// has no runtime-constant-array counterpart inside packages/shared (the
// one Record keyed by it, `DEFAULT_TRIGGERS`, lives in
// packages/server/src/services/notifications/notification-manager.ts,
// which depends on packages/shared, not the reverse) -- so the type pin is
// mirrored here rather than replaced by a bun:test assertion.
//
// MANUAL VERIFICATION (not committed): dropping `'worker:exited'` from
// `NotificationEvent` (leaving it in `OutboundTriggerEventType`) made
// `_AssertComplete` fail with `error TS2344: Type 'false' does not satisfy
// the constraint 'true'.`; adding a `NotificationEvent` member with no
// matching `OutboundTriggerEventType` value made `_AssertValidTypes` fail
// with the same error. Reverting each drift restored a clean
// `tsc --noEmit`. See `../notification.ts`'s own assertion comment for the
// full record.
// -----------------------------------------------------------------------
type Assert<T extends true> = T;

type _AssertValidTypes = Assert<NotificationEvent['type'] extends OutboundTriggerEventType ? true : false>;
type _AssertComplete = Assert<OutboundTriggerEventType extends NotificationEvent['type'] ? true : false>;

export type { _AssertValidTypes, _AssertComplete };

describe('NotificationEvent / OutboundTriggerEventType parity', () => {
  it('is enforced at compile time (see the type-level pin above)', () => {
    // No runtime behavior to assert -- this test file exists to host the
    // sibling type pin per test-trigger.md's coverage requirement.
    expect(true).toBe(true);
  });
});
