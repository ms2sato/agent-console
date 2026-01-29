import type { Context, Next } from 'hono';
import { validator } from 'hono/validator';
import * as v from 'valibot';
import { ValidationError } from '../lib/errors.js';

/**
 * Hono-compatible Valibot validation middleware.
 * Unlike validateBody, this integrates with Hono's type inference system,
 * enabling full end-to-end type safety with Hono RPC.
 */
export function vValidator<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator('json', (value) => {
    const result = v.safeParse(schema, value);
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
    return result.output as v.InferOutput<TSchema>;
  });
}

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
 * Hono-compatible Valibot validation middleware for query parameters.
 * Integrates with Hono's type inference system for end-to-end type safety.
 */
export function vQueryValidator<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator('query', (value) => {
    const result = v.safeParse(schema, value);
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
    return result.output as v.InferOutput<TSchema>;
  });
}

/**
 * Get validated body from context
 * Type-safe helper to retrieve validated data
 * @throws ValidationError if called without validateBody middleware
 */
export function getValidatedBody<T>(c: Context): T {
  const val = c.get('validatedBody');
  if (val === undefined) {
    throw new ValidationError('getValidatedBody called without validateBody middleware');
  }
  return val as T;
}

/**
 * Valibot validation middleware for optional JSON body.
 * If no body is provided, validates an empty object against the schema.
 * Useful for DELETE endpoints that optionally accept a body.
 */
export function maybeValidateBody<TSchema extends v.GenericSchema>(schema: TSchema) {
  return async (c: Context, next: Next) => {
    let body: unknown = {};

    // Try to parse JSON body, but allow empty body
    const contentType = c.req.header('content-type');
    if (contentType?.includes('application/json')) {
      try {
        body = await c.req.json();
      } catch {
        // Empty or invalid JSON - use empty object
      }
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

    c.set('validatedBody', result.output);
    await next();
  };
}

/**
 * Get maybe-validated body from context
 * Type-safe helper to retrieve validated data from maybeValidateBody middleware
 * @throws ValidationError if called without maybeValidateBody middleware
 */
export function getMaybeValidatedBody<T>(c: Context): T {
  const val = c.get('validatedBody');
  if (val === undefined) {
    throw new ValidationError('getMaybeValidatedBody called without maybeValidateBody middleware');
  }
  return val as T;
}
