import type { Context, Env, MiddlewareHandler, Next } from 'hono';
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

/**
 * Like {@link vValidator}, but the JSON body itself is optional: no body, a blank body (with or
 * without a JSON content type) and `{}` all validate as an empty object, and a present body is
 * validated against `schema`.
 *
 * Hono's own `validator('json')` answers 400 "Malformed JSON" for a blank body that carries a JSON
 * content type (what `fetch` sends from a client that sets the header but no body), so it cannot
 * express "optional body". The schema should therefore accept `{}`.
 */
export function vOptionalJsonValidator<TSchema extends v.GenericSchema>(
  schema: TSchema,
): MiddlewareHandler<
  Env,
  string,
  { in: { json?: v.InferInput<TSchema> }; out: { json: v.InferOutput<TSchema> } }
> {
  return async (c: Context, next: Next) => {
    const text = await c.req.text();
    // A malformed non-blank body throws SyntaxError, which the API error handler maps to 400.
    const value: unknown = text.trim() === '' ? {} : JSON.parse(text);
    const result = v.safeParse(schema, value);
    if (!result.success) {
      throw new ValidationError(formatValibotError(result.issues));
    }
    c.req.addValidatedData('json', result.output as object);
    await next();
  };
}
