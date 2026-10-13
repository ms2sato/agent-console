import { describe, it, expect } from 'bun:test';
import {
  WORKER_SERVER_MESSAGE_TYPES,
  APP_CLIENT_MESSAGE_TYPES,
  type WorkerServerMessage,
  type WorkerServerMessageType,
  type AppClientMessage,
} from '../session.js';
import { GIT_DIFF_SERVER_MESSAGE_TYPES, type GitDiffServerMessage } from '../git-diff.js';

// Compile-time parity between each protocol message-type const and its hand-written union.
//
// Each union (`WorkerServerMessage`, `GitDiffServerMessage`, `AppClientMessage`) is written by
// hand next to a `*_MESSAGE_TYPES` const that the runtime validates against. Nothing tied the two
// together at type level, so a member added to one and not the other compiled fine and only
// surfaced at runtime as a dropped frame. These pins make that drift a compile error today;
// deriving the union FROM the const is a separate, structural change.
//
// `Assert<Equals<...>>` fails `tsc` (TS2344) under drift; a `declare const x: never` form would
// type-check under it (workflow.md, "Pins include type-level assertions").
//
// Reach, measured (control: `tsc` clean): adding a bogus key to WORKER_SERVER_MESSAGE_TYPES and
// removing a union member each fail the corresponding pin with TS2344 (recorded in the PR body).

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type _WorkerServerMessageParity = Assert<Equals<WorkerServerMessage['type'], WorkerServerMessageType>>;
export type _GitDiffServerMessageParity = Assert<
  Equals<GitDiffServerMessage['type'], keyof typeof GIT_DIFF_SERVER_MESSAGE_TYPES>
>;
export type _AppClientMessageParity = Assert<Equals<AppClientMessage['type'], keyof typeof APP_CLIENT_MESSAGE_TYPES>>;

describe('message type consts: ordinals are wire identifiers', () => {
  it.each([
    ['WORKER_SERVER_MESSAGE_TYPES', WORKER_SERVER_MESSAGE_TYPES],
    ['GIT_DIFF_SERVER_MESSAGE_TYPES', GIT_DIFF_SERVER_MESSAGE_TYPES],
    ['APP_CLIENT_MESSAGE_TYPES', APP_CLIENT_MESSAGE_TYPES],
  ] as const)('%s assigns a distinct positive integer ordinal to every type', (_name, consts) => {
    const ordinals = Object.values(consts) as number[];
    expect(ordinals.length).toBeGreaterThan(0);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(ordinals.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  });
});
