import * as v from 'valibot';

/** Wire schema for one member of the user directory: id and username only. */
export const DirectoryUserSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  username: v.string(),
});

/** Wire schema for `GET /api/users`. */
export const UsersListResponseSchema = v.strictObject({
  users: v.array(DirectoryUserSchema),
});

export type UsersListResponse = v.InferOutput<typeof UsersListResponseSchema>;
