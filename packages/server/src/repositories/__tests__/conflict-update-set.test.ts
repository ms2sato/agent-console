import { describe, it, expect } from 'bun:test';
import { conflictUpdateSet } from '../conflict-update-set.js';
import type { WorkerRowFull } from '../../database/schema.js';

describe('conflictUpdateSet', () => {
  it('builds the update object from the row minus the immutable keys (mixed)', () => {
    const row = { id: '1', created_at: 't0', name: 'a', value: 1 };
    const result = conflictUpdateSet(row, ['id', 'created_at'] as const);
    expect(result).toEqual({ name: 'a', value: 1 });
  });

  it('returns the full row when the immutable list is empty (all-mutable boundary)', () => {
    const row = { id: '1', name: 'a' };
    const result = conflictUpdateSet(row, [] as const);
    expect(result).toEqual({ id: '1', name: 'a' });
  });

  it('returns an empty object when every key is immutable (all-immutable boundary)', () => {
    const row = { id: '1', created_at: 't0' };
    const result = conflictUpdateSet(row, ['id', 'created_at'] as const);
    expect(result).toEqual({});
  });

  it('returns an empty object for a row with no keys (empty-input / vacuous-truth boundary)', () => {
    const row = {};
    const result = conflictUpdateSet(row, [] as const);
    expect(result).toEqual({});
  });

  it('excludes a single immutable key, keeping the rest (single-element boundary)', () => {
    const row = { id: '1', name: 'a', value: 1 };
    const result = conflictUpdateSet(row, ['id'] as const);
    expect(result).toEqual({ name: 'a', value: 1 });
  });

  it('does not mutate the input row', () => {
    const row = { id: '1', name: 'a' };
    conflictUpdateSet(row, ['id'] as const);
    expect(row).toEqual({ id: '1', name: 'a' });
  });
});

// -----------------------------------------------------------------------
// Type-level pin (Issue #1339): conflictUpdateSet's totality contract --
// Row must be `Required<Insertable<XTable>>`-shaped (here, `WorkerRowFull`,
// defined in `../../database/schema.ts`) so that an omitted column is a
// compile error, never a silently-dropped key at runtime. Per
// `.claude/rules/workflow.md`'s "pins include type-level assertions"
// section, `declare const x: never` is inert here (no assignment for
// `never` to reject); this uses `Assert<T extends true>` instead.
//
// Reach measured 2026-10-10:
//
// (1) Temporarily removed `auto_compaction: 1,` from toWorkerRow's
//     'terminal' branch in `../../database/mappers.ts` and ran
//     `bunx tsc --noEmit -p packages/server`. Diagnostic produced:
//
//       packages/server/src/database/mappers.ts(167,5): error TS2741:
//       Property 'auto_compaction' is missing in type '{ pid: number |
//       null; agent_id: null; base_commit: null; embedded_agent_id: null;
//       deliver_initial_prompt_on_activation: null; sdk_session_id: null;
//       model: null; reasoning_effort: null; context_window_tokens: null;
//       ... 5 more ...; updated_at: string; }' but required in type
//       'Required<{ type: "agent" | "terminal" | "git-diff" |
//       "embedded-agent"; name: string; id: string; session_id: string; }
//       & { model?: string | null | undefined; created_at?: string |
//       undefined; ... 9 more ...; context_window_tokens?: number | ... 1
//       more ... | undefined; }>'.
//
//     Reverted immediately after capturing the diagnostic.
//
// (2) Temporarily added `fake_column: string | null;` to `WorkersTable` in
//     `../../database/schema.ts` and ran the same command. One diagnostic
//     per branch of toWorkerRow's type switch, since none declare the fake
//     column (4 branches -- 'agent', 'terminal', 'git-diff',
//     'embedded-agent' -- at mappers.ts lines 145/167/181/195):
//
//       packages/server/src/database/mappers.ts(145,5): error TS2741:
//       Property 'fake_column' is missing in type '{ pid: number | null;
//       agent_id: string; base_commit: null; embedded_agent_id: null;
//       deliver_initial_prompt_on_activation: number; sdk_session_id: null;
//       auto_compaction: number; model: string | null; ... 7 more ...;
//       updated_at: string; }' but required in type 'Required<{ type:
//       "agent" | "terminal" | "git-diff" | "embedded-agent"; name: string;
//       id: string; session_id: string; } & { model?: string | null |
//       undefined; created_at?: string | undefined; ... 10 more ...;
//       fake_column?: string | ... 1 more ... | undefined; }>'.
//
//       packages/server/src/database/mappers.ts(167,5): error TS2741:
//       Property 'fake_column' is missing in type '{ pid: number | null;
//       agent_id: null; base_commit: null; embedded_agent_id: null;
//       deliver_initial_prompt_on_activation: null; sdk_session_id: null;
//       auto_compaction: number; model: null; ... 7 more ...; updated_at:
//       string; }' but required in type 'Required<{ type: "agent" |
//       "terminal" | "git-diff" | "embedded-agent"; name: string; id:
//       string; session_id: string; } & { model?: string | null |
//       undefined; created_at?: string | undefined; ... 10 more ...;
//       fake_column?: string | ... 1 more ... | undefined; }>'.
//
//       packages/server/src/database/mappers.ts(181,5): error TS2741:
//       Property 'fake_column' is missing in type '{ pid: null; agent_id:
//       null; base_commit: string; embedded_agent_id: null;
//       deliver_initial_prompt_on_activation: null; sdk_session_id: null;
//       auto_compaction: number; model: null; reasoning_effort: null; ... 6
//       more ...; updated_at: string; }' but required in type 'Required<{
//       type: "agent" | "terminal" | "git-diff" | "embedded-agent"; name:
//       string; id: string; session_id: string; } & { model?: string |
//       null | undefined; created_at?: string | undefined; ... 10 more
//       ...; fake_column?: string | ... 1 more ... | undefined; }>'.
//
//       packages/server/src/database/mappers.ts(195,5): error TS2741:
//       Property 'fake_column' is missing in type '{ pid: number | null;
//       agent_id: null; base_commit: null; embedded_agent_id: string;
//       deliver_initial_prompt_on_activation: number; sdk_session_id:
//       string | null; auto_compaction: number; ... 8 more ...;
//       updated_at: string; }' but required in type 'Required<{ type:
//       "agent" | "terminal" | "git-diff" | "embedded-agent"; name: string;
//       id: string; session_id: string; } & { model?: string | null |
//       undefined; created_at?: string | undefined; ... 10 more ...;
//       fake_column?: string | ... 1 more ... | undefined; }>'.
//
//     (The sibling test file `mappers.test.ts` also produced 15 analogous
//     diagnostics against its own hand-built fixture rows, for the same
//     reason -- they are not pasted here since the pin above is about
//     toWorkerRow's own branches, not its test file.)
//
//     Reverted immediately after capturing the diagnostic.
// -----------------------------------------------------------------------
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _WorkerConflictUpdateSetKeys = keyof ReturnType<
  typeof conflictUpdateSet<WorkerRowFull, ['id', 'created_at']>
>;

type _A = Assert<
  Equals<_WorkerConflictUpdateSetKeys, Exclude<keyof WorkerRowFull, 'id' | 'created_at'>>
>;

// `export type` (rather than a `declare const` runtime reference) is what
// satisfies `noUnusedLocals` here -- `Assert<T extends true>` already fails
// `tsc` at the alias's own declaration site when the condition is false, so
// no runtime binding is needed to make the check fire. Mirrors the export
// pattern used for this exact idiom in
// `packages/shared/src/types/__tests__/session.test.ts`.
export type { _A };
