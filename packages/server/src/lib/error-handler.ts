import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('error-handler');

/**
 * Error response format
 */
interface ErrorResponse {
  error: string;
  code?: string;
}

/**
 * Error handler middleware for Hono
 * Catches ApiError instances and formats them consistently
 */
export const errorHandler: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (error) {
    return handleError(c, error);
  }
};

/**
 * Format error response based on error type
 */
function handleError(c: Context, error: unknown): Response {
  // JSON parse errors from Hono's validator('json') when body is invalid/empty
  if (error instanceof SyntaxError || (error instanceof Error && error.message === 'Malformed JSON in request body')) {
    logger.warn(
      { method: c.req.method, path: c.req.path, status: 400, message: 'Invalid JSON body' },
      'API error'
    );
    return c.json({ error: 'Invalid JSON body' } as ErrorResponse, 400);
  }

  if (error instanceof ApiError) {
    // Log API errors at warn level (expected errors)
    logger.warn(
      { method: c.req.method, path: c.req.path, status: error.statusCode, message: error.message },
      'API error'
    );
    const body: ErrorResponse = {
      error: error.message,
    };
    return c.json(body, error.statusCode as 400 | 404 | 409 | 500);
  }

  // Log unexpected errors at error level
  logger.error(
    { method: c.req.method, path: c.req.path, err: error },
    'Unexpected error'
  );

  // Return generic error for non-API errors
  const message = error instanceof Error ? error.message : 'Unknown error';
  return c.json({ error: message }, 500);
}

/**
 * Hono's onError handler (alternative approach)
 * Can be used with app.onError()
 */
export function onApiError(error: Error, c: Context): Response {
  return handleError(c, error);
}
