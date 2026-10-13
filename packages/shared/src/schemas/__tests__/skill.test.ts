import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import type { SkillDefinition } from '../../types/skill';
import { SkillDefinitionSchema, SkillsResponseSchema } from '../skill';

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The hand-written `SkillDefinition` domain type and the wire schema must stay one shape.
export type _SkillMatchesSchema = Assert<Equals<SkillDefinition, v.InferOutput<typeof SkillDefinitionSchema>>>;

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
