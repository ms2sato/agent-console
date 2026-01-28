import * as v from 'valibot';

/**
 * Schema for system/open request
 */
export const SystemOpenRequestSchema = v.object({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
});

/**
 * Schema for system/open-in-vscode request
 */
export const SystemOpenVSCodeRequestSchema = v.object({
  path: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Path is required')
  ),
});

// Inferred types from schemas
export type SystemOpenRequest = v.InferOutput<typeof SystemOpenRequestSchema>;
export type SystemOpenVSCodeRequest = v.InferOutput<typeof SystemOpenVSCodeRequestSchema>;
