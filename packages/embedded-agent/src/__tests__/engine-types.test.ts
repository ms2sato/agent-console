import { describe, it, expect } from 'bun:test';
import type { ClaudeSdkEngine, Engine } from '../engine-types.js';

// -----------------------------------------------------------------------
// Type-level compile pin (Phase 4, #1683 decision 5): `Engine` must have no
// member named `compactNow` or `dispose` -- both moved off it entirely, onto
// the kind-discriminated `OpenAiApiEngine` / `ClaudeSdkEngine` interfaces.
// Per `.claude/rules/workflow.md`'s "pins include type-level assertions"
// section, a pin using `declare const x: never` is inert (`declare`
// introduces no assignment for `never` to reject). This uses
// `Assert<T extends true>` instead, which genuinely fails `tsc` when the
// condition is false -- same idiom as
// `packages/shared/src/types/__tests__/notification.test.ts`.
//
// Reach measured 2026-09-14: temporarily re-added `compactNow?(): Promise<
// void>;` as the last member of `Engine` in `../engine-types.ts` and ran
// `bunx tsc --noEmit -p packages/embedded-agent`. Diagnostic produced:
//
//   src/__tests__/engine-types.test.ts(4,35): error TS2344: Type 'false'
//   does not satisfy the constraint 'true'.
//
// (pointing at `_AssertNoCompactNow` below, since `'compactNow' extends
// keyof Engine` became `true` and the conditional resolved to `false`).
// Reverted immediately after capturing the diagnostic -- `keyof Engine`
// includes optional members, so re-adding either method as OPTIONAL (the
// pre-split shape) is exactly the regression this pin exists to catch, not
// only a required re-add.
// -----------------------------------------------------------------------
type Assert<T extends true> = T;

type _AssertNoCompactNow = Assert<'compactNow' extends keyof Engine ? false : true>;
type _AssertNoDispose = Assert<'dispose' extends keyof Engine ? false : true>;

/**
 * epic #1636 Phase 5 PR-2: `ClaudeSdkEngine` must have a `setMcpServers`
 * member -- same `Assert<T extends true>` idiom as the two pins above (a
 * `declare const x: never` form is inert here for the identical reason their
 * own comment explains).
 */
type _AssertHasSetMcpServers = Assert<'setMcpServers' extends keyof ClaudeSdkEngine ? true : false>;

export type { _AssertNoCompactNow, _AssertNoDispose, _AssertHasSetMcpServers };

describe('Engine — no compactNow/dispose member (Phase 4, #1683 decision 5)', () => {
  it('is enforced at compile time (see the type-level pin above)', () => {
    // No runtime behavior to assert -- this test file exists to host the
    // sibling type pin per test-trigger.md's coverage requirement (and the
    // naming-exemption guard's own note in engine-types.ts).
    expect(true).toBe(true);
  });
});
