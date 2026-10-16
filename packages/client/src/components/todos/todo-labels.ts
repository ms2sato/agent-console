import type { Todo, UsersListResponse } from '@agent-console/shared';

type DirectoryUsers = UsersListResponse['users'];

export function usernameOf(users: DirectoryUsers, userId: string): string {
  return users.find((user) => user.id === userId)?.username ?? 'unknown user';
}

export function creatorLabel(todo: Todo, users: DirectoryUsers): string {
  return 'userId' in todo.createdBy ? usernameOf(users, todo.createdBy.userId) : 'an agent';
}
