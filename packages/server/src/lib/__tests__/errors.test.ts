import { describe, it, expect } from 'bun:test';
import {
  ApiError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InternalError,
} from '../errors.js';

describe('Error Classes', () => {
  describe('ApiError', () => {
    it('should create error with message and status code', () => {
      const error = new ApiError('Something went wrong', 400);

      expect(error.message).toBe('Something went wrong');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('ApiError');
      expect(error).toBeInstanceOf(Error);
    });

    it('should be catchable as Error', () => {
      const error = new ApiError('Test', 500);

      expect(() => {
        throw error;
      }).toThrow(Error);
    });
  });

  describe('ValidationError', () => {
    it('should create error with 400 status code', () => {
      const error = new ValidationError('Invalid input');

      expect(error.message).toBe('Invalid input');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('ValidationError');
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  describe('NotFoundError', () => {
    it('should create error with 404 status code and formatted message', () => {
      const error = new NotFoundError('Session');

      expect(error.message).toBe('Session not found');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('NotFoundError');
      expect(error).toBeInstanceOf(ApiError);
    });

    it('should handle different resource names', () => {
      const repoError = new NotFoundError('Repository');
      expect(repoError.message).toBe('Repository not found');

      const agentError = new NotFoundError('Agent');
      expect(agentError.message).toBe('Agent not found');
    });
  });

  describe('ConflictError', () => {
    it('should create error with 409 status code', () => {
      const error = new ConflictError('Resource already exists');

      expect(error.message).toBe('Resource already exists');
      expect(error.statusCode).toBe(409);
      expect(error.name).toBe('ConflictError');
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  describe('InternalError', () => {
    it('should create error with 500 status code and default message', () => {
      const error = new InternalError();

      expect(error.message).toBe('Internal server error');
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('InternalError');
      expect(error).toBeInstanceOf(ApiError);
    });

    it('should accept custom message', () => {
      const error = new InternalError('Database connection failed');

      expect(error.message).toBe('Database connection failed');
      expect(error.statusCode).toBe(500);
    });
  });

  describe('Error inheritance', () => {
    it('all error types should be instanceof ApiError', () => {
      expect(new ValidationError('test')).toBeInstanceOf(ApiError);
      expect(new NotFoundError('test')).toBeInstanceOf(ApiError);
      expect(new ConflictError('test')).toBeInstanceOf(ApiError);
      expect(new InternalError()).toBeInstanceOf(ApiError);
    });

    it('all error types should be instanceof Error', () => {
      expect(new ValidationError('test')).toBeInstanceOf(Error);
      expect(new NotFoundError('test')).toBeInstanceOf(Error);
      expect(new ConflictError('test')).toBeInstanceOf(Error);
      expect(new InternalError()).toBeInstanceOf(Error);
    });
  });
});
