import type { Context, Next } from 'hono';
import * as v from 'valibot';
import { ValidationError } from '../lib/errors.js';

/**
 * Valibot validation middleware for Hono
 * Validates request body against a schema and sets validated data in context
 */
export function validateBody<TSchema extends v.GenericSchema>(schema: TSchema) {
  return async (c: Context, next: Next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Invalid JSON body');
    }
    const result = v.safeParse(schema, body);

    if (!result.success) {
      const firstIssue = result.issues[0];
      const path = firstIssue?.path
        ?.map((p) => ('key' in p ? String(p.key) : ''))
        .filter(Boolean)
        .join('.') || '';
      const message = path
        ? `${path}: ${firstIssue?.message}`
        : firstIssue?.message || 'Validation failed';
      throw new ValidationError(message);
    }

    // Store validated data in context for handlers
    c.set('validatedBody', result.output);
    await next();
  };
}

/**
 * Get validated body from context
 * Type-safe helper to retrieve validated data
 */
export function getValidatedBody<T>(c: Context): T {
  return c.get('validatedBody') as T;
}
