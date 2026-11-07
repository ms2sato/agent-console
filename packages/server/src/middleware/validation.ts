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

/** `application/json` or `application/*+json`, parameters allowed, case-insensitive. */
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json\s*(?:;|$)/i;

/**
 * Like {@link vValidator}, but the JSON body itself is optional: an empty body and `{}` both
 * validate as an empty object, and a present body is validated against `schema`.
 *
 * Every request must carry a JSON `Content-Type`, body or not; anything else is a 400 with a fixed
 * message, answered before the body is read. This matters for routes that change state: a
 * cross-site HTML form can send `text/plain` (a simple request, no CORS preflight), and without
 * this check an optional body would let such a form through. Hono's own `validator('json')` does
 * not refuse a non-JSON type, it silently validates `{}` instead, which is why the check lives here.
 *
 * Hono's validator also answers 400 "Malformed JSON" for an empty body that carries a JSON content
 * type (what `fetch` sends from a client that sets the header but no body), so it cannot express
 * "optional body". The schema should therefore accept `{}`.
 */
export function vOptionalJsonValidator<TSchema extends v.GenericSchema>(
  schema: TSchema,
): MiddlewareHandler<
  Env,
  string,
  { in: { json?: v.InferInput<TSchema> }; out: { json: v.InferOutput<TSchema> } }
> {
  return async (c: Context, next: Next) => {
    if (!JSON_CONTENT_TYPE.test(c.req.header('Content-Type') ?? '')) {
      throw new ValidationError('Content-Type must be application/json');
    }
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
