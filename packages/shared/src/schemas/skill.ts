import * as v from 'valibot';

/** A discovered slash-command skill as it crosses the wire. */
export const SkillDefinitionSchema = v.strictObject({
  name: v.string(),
  description: v.string(),
});

/** Schema for `GET /api/skills`'s response. */
export const SkillsResponseSchema = v.strictObject({
  skills: v.array(SkillDefinitionSchema),
});

export type SkillsResponse = v.InferOutput<typeof SkillsResponseSchema>;
