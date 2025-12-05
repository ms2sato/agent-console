/**
 * Base class for API errors
 */
export class ApiError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/**
 * 400 Bad Request - Validation or input errors
 */
export class ValidationError extends ApiError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

/**
 * 404 Not Found - Resource not found
 */
export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

/**
 * 409 Conflict - Resource conflict
 */
export class ConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalError extends ApiError {
  constructor(message: string = 'Internal server error') {
    super(message, 500);
    this.name = 'InternalError';
  }
}
