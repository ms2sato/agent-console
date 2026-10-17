import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { SkillsResponseSchema, type SkillDefinition } from '../skill';

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Key-set pin. `SkillDefinition` is derived from `SkillDefinitionSchema`, so the schema is the
// only place a field is edited; the pin compares `keyof` with an explicit literal union, so a
// field added to (or removed from) the schema alone is a `tsc` failure (TS2344) naming the
// difference. `Assert<Equals<...>>` is the form that fails under drift; a `declare const x: never`
// form would type-check under it.
//
// Measured reach: (`tsc` diagnostics, control clean first): adding a field to, or removing one
// from, `SkillDefinitionSchema` fails `_SkillDefinitionKeys` (TS2344, and only it). The diagnostic sits on
// the pin's line and does not name the key.
export type _SkillDefinitionKeys = Assert<Equals<keyof SkillDefinition, 'name' | 'description'>>;

describe('SkillsResponseSchema', () => {
  it('accepts an empty list (the route returns [] when discovery fails) and a skill list', () => {
    expect(v.safeParse(SkillsResponseSchema, { skills: [] }).success).toBe(true);
    expect(v.safeParse(SkillsResponseSchema, { skills: [{ name: 'review', description: 'Review code' }] }).success).toBe(true);
  });

  it('rejects a skill without a description, an extra skill field and an extra top-level key', () => {
    expect(v.safeParse(SkillsResponseSchema, { skills: [{ name: 'review' }] }).success).toBe(false);
    expect(v.safeParse(SkillsResponseSchema, { skills: [{ name: 'a', description: 'b', extra: 1 }] }).success).toBe(false);
    expect(v.safeParse(SkillsResponseSchema, { skills: [], extra: 1 }).success).toBe(false);
  });
});
