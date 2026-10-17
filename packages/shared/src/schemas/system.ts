import * as v from 'valibot';

/**
 * Schema for system/open request
 */
export const SystemOpenRequestSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
});

/**
 * Schema for system/open-in-vscode request
 */
export const SystemOpenVSCodeRequestSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
});

/**
 * Response of GET /api/system/health.
 */
export const SystemHealthResponseSchema = v.strictObject({
  webhookSecretConfigured: v.boolean(),
  appUrl: v.nullable(v.string()),
});

// Inferred types from schemas
export type SystemOpenRequest = v.InferOutput<typeof SystemOpenRequestSchema>;
export type SystemOpenVSCodeRequest = v.InferOutput<typeof SystemOpenVSCodeRequestSchema>;
export type SystemHealthResponse = v.InferOutput<typeof SystemHealthResponseSchema>;
