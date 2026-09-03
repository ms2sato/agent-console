import { describe, it, expect } from 'bun:test';
import { WORKER_SERVER_MESSAGE_TYPES, type WorkerServerMessage, type WorkerServerMessageType } from '../session.js';
import type { UpdateSessionMemoRequest } from '../session.js';

describe('UpdateSessionMemoRequest (re-exported from schemas/session.js, Issue #1569)', () => {
  it('is re-exported as a type with a required string content field', () => {
    const request: UpdateSessionMemoRequest = { content: 'hello' };
    expect(request.content).toBe('hello');
  });
});

describe('WORKER_SERVER_MESSAGE_TYPES', () => {
  it('assigns a distinct ordinal to every message type', () => {
    const ordinals = Object.values(WORKER_SERVER_MESSAGE_TYPES);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("includes 'restore-info' at ordinal 9 (Transcript Restore #1123)", () => {
    expect(WORKER_SERVER_MESSAGE_TYPES['restore-info']).toBe(9);
  });

  it("'restore-info' is a valid WorkerServerMessageType key", () => {
    const key: WorkerServerMessageType = 'restore-info';
    expect(WORKER_SERVER_MESSAGE_TYPES[key]).toBe(9);
  });
});

describe('WorkerServerMessage — restore-info variant (Transcript Restore #1123)', () => {
  it('accepts the expected shape', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 42,
      restoredMessageCount: 5,
      repairedToolCallIds: ['call-1'],
      completed: true,
    };
    expect(message.type).toBe('restore-info');
    if (message.type === 'restore-info') {
      expect(message.epoch).toBe(42);
      expect(message.restoredMessageCount).toBe(5);
      expect(message.repairedToolCallIds).toEqual(['call-1']);
      expect(message.completed).toBe(true);
    }
  });

  it('accepts an empty repairedToolCallIds array (no repair needed)', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 1,
      restoredMessageCount: 0,
      repairedToolCallIds: [],
      completed: false,
    };
    expect(message.repairedToolCallIds).toEqual([]);
  });

  it('distinguishes completed: false (restore delivered, incarnation not yet ready) from completed: true (Issue #1205)', () => {
    const notYetReady: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 7,
      restoredMessageCount: 3,
      repairedToolCallIds: [],
      completed: false,
    };
    const ready: WorkerServerMessage = { ...notYetReady, completed: true };
    expect(notYetReady.completed).toBe(false);
    expect(ready.completed).toBe(true);
  });
});

describe('WorkerServerMessage — restore-info FAILURE variant (#1449)', () => {
  it('accepts the minimal failure shape (no sdkResumed -- openai-api)', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 9,
      failed: true,
    };
    expect(message.type).toBe('restore-info');
    if (message.type === 'restore-info' && message.failed === true) {
      // Narrowed to the failure member: `sdkResumed` is a valid access here
      // (optional on this member), and `'sdkResumed' in message` correctly
      // reads absence rather than `undefined`.
      expect(message.sdkResumed).toBeUndefined();
      expect('sdkResumed' in message).toBe(false);
    } else {
      throw new Error('expected the failure form to narrow');
    }
  });

  it('accepts the failure shape with sdkResumed (claude-sdk)', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 9,
      failed: true,
      sdkResumed: true,
    };
    if (message.type === 'restore-info' && message.failed === true) {
      expect(message.sdkResumed).toBe(true);
    } else {
      throw new Error('expected the failure form to narrow');
    }
  });
});

// -----------------------------------------------------------------------
// Type-level compile pin (#1449): the `failed` discriminant actually
// narrows the `restore-info` union member, not just at the value level
// tested above but at the TYPE level -- per `.claude/rules/workflow.md`'s
// "pins include type-level assertions" section, a pin using `never` as the
// constraint is inert (`declare const x: never` type-checks even when the
// asserted condition is false, because `declare` introduces no assignment
// for `never` to reject). This uses `Assert<T extends true>` instead, which
// genuinely fails `tsc` when the condition is false.
//
// MANUAL VERIFICATION (not committed, per the rule's "temporarily breaking
// the union on purpose" instruction): adding a `completed: boolean` field to
// the failure member in `../session.ts` made `_FailureHasNoCompletedField`
// below fail with `error TS2344: Type 'false' does not satisfy the
// constraint 'true'` -- confirming the pin actually rejects a dropped/
// non-narrowing discriminant rather than passing regardless. Reverting the
// added field restored a clean `tsc --noEmit`.
// -----------------------------------------------------------------------
type Assert<T extends true> = T;
type RestoreInfoMessage = Extract<WorkerServerMessage, { type: 'restore-info' }>;
type RestoreInfoFailureMessage = Extract<RestoreInfoMessage, { failed: true }>;
type RestoreInfoSuccessMessage = Exclude<RestoreInfoMessage, { failed: true }>;

type _FailureHasNoCompletedField = Assert<'completed' extends keyof RestoreInfoFailureMessage ? false : true>;
type _SuccessHasCompletedField = Assert<'completed' extends keyof RestoreInfoSuccessMessage ? true : false>;
type _FailureHasNoRestoredMessageCountField = Assert<
  'restoredMessageCount' extends keyof RestoreInfoFailureMessage ? false : true
>;
// The discriminant itself narrows the union to exactly one member per value:
// a failure-typed message cannot simultaneously be assignable to the
// success member's required-field shape.
type _FailureIsNotAssignableToSuccess = Assert<
  RestoreInfoFailureMessage extends RestoreInfoSuccessMessage ? false : true
>;
// `export type` (rather than a `declare const` runtime reference) is what
// satisfies `noUnusedLocals` here -- `Assert<T extends true>` already fails
// `tsc` at the alias's OWN declaration site when T is false, so no runtime
// binding is needed to make the check fire; a `declare const` would only
// introduce a ReferenceError at test-run time, since `declare` emits no
// actual JS value. Mirrors the export pattern already used for this exact
// idiom in `packages/shared/src/schemas/embedded-agent.ts`.
export type {
  _FailureHasNoCompletedField,
  _SuccessHasCompletedField,
  _FailureHasNoRestoredMessageCountField,
  _FailureIsNotAssignableToSuccess,
};
