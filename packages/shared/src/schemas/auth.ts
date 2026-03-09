import * as v from 'valibot';

/**
 * Schema for login request payload.
 * Validates that both username and password are non-empty strings.
 */
export const LoginRequestSchema = v.object({
  username: v.pipe(v.string(), v.minLength(1, 'Username is required')),
  password: v.pipe(v.string(), v.minLength(1, 'Password is required')),
});

export type LoginRequest = v.InferOutput<typeof LoginRequestSchema>;
