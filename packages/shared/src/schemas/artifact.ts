import * as v from 'valibot';

/**
 * Wire schema for the `Artifact` summary shape (HTML Artifacts phase 1).
 * Mirrors `types/artifact.ts`'s `Artifact` interface field-for-field
 * so a server response that silently drops/adds a field fails to parse
 * instead of failing silently at the client (see
 * `.claude/rules/pre-pr-completeness.md` Q10, the #926 lesson).
 */
export const ArtifactSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  createdAt: v.string(),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type ArtifactSchemaOutput = v.InferOutput<typeof ArtifactSchema>;

/**
 * Wire schema for `GET /api/artifacts`'s list response (HTML Artifacts
 * phase 2). Parsed at the client fetch boundary so a server response that
 * silently drops/adds a field fails to parse instead of failing silently
 * at the client (see `.claude/rules/pre-pr-completeness.md` Q10, the #926
 * lesson).
 */
export const ArtifactsListResponseSchema = v.strictObject({
  artifacts: v.array(ArtifactSchema),
});

export type ArtifactsListResponse = v.InferOutput<typeof ArtifactsListResponseSchema>;
