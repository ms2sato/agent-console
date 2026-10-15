/**
 * Member directory route.
 *
 * Mounted inside the `/api` mount AFTER `.use('*', authMiddleware)`. Any
 * authenticated member may list the directory (it backs assignee pickers).
 * Only `id` and `username` leave the server: never the OS uid, home
 * directory or any credential-adjacent column.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';

const users = new Hono<AppBindings>().get('/', async (c) => {
  const { userRepository } = c.get('appContext');
  const all = await userRepository.findAll();
  return c.json({ users: all.map((user) => ({ id: user.id, username: user.username })) });
});

export { users };
