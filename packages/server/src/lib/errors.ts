/**
 * Base class for API errors
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  /** Optional machine-readable error code surfaced in the HTTP response body. */
  public readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
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

/**
 * 404 Not Found - Repository not resolvable by id.
 * Used by session creation flows that require a valid repository.
 */
export class RepositoryNotFoundError extends ApiError {
  constructor(repositoryId: string) {
    super(`Repository not found: ${repositoryId}`, 404, 'repository_not_found');
    this.name = 'RepositoryNotFoundError';
  }
}

/**
 * 409 Conflict - Session exists but is marked orphaned and cannot be resumed.
 * Distinct from `NotFoundError` so clients can offer a "delete orphan" flow
 * rather than treat the session as already-deleted.
 */
export class SessionOrphanedError extends ApiError {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is orphaned and cannot be resumed`, 409, 'session_orphaned');
    this.name = 'SessionOrphanedError';
  }
}
