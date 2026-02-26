import { validator } from 'hono/validator';
import * as v from 'valibot';
import { ValidationError } from '../lib/errors.js';

/**
 * Format a Valibot validation error into a user-friendly message.
 * Extracts the first issue's path and message.
 */
function formatValibotError(issues: v.BaseIssue<unknown>[]): string {
  const firstIssue = issues[0];
  const path = firstIssue?.path
    ?.map((p) => ('key' in p ? String(p.key) : ''))
    .filter(Boolean)
    .join('.') || '';
  return path
    ? `${path}: ${firstIssue?.message}`
    : firstIssue?.message || 'Validation failed';
}

/**
 * Hono-compatible Valibot validation middleware for JSON body.
 * Integrates with Hono's type inference system for end-to-end type safety.
 */
export function vValidator<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator('json', (value) => {
    const result = v.safeParse(schema, value);
    if (!result.success) {
      throw new ValidationError(formatValibotError(result.issues));
    }
    return result.output as v.InferOutput<TSchema>;
  });
}

/**
 * Hono-compatible Valibot validation middleware for query parameters.
 * Integrates with Hono's type inference system for end-to-end type safety.
 */
export function vQueryValidator<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator('query', (value) => {
    const result = v.safeParse(schema, value);
    if (!result.success) {
      throw new ValidationError(formatValibotError(result.issues));
    }
    return result.output as v.InferOutput<TSchema>;
  });
}
