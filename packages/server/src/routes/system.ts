import { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import open from 'open';
import type { SystemOpenRequest } from '@agent-console/shared';
import { SystemOpenRequestSchema } from '@agent-console/shared';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';

const system = new Hono();

// Open a file or directory in the default application (Finder/Explorer)
system.post('/open', validateBody(SystemOpenRequestSchema), async (c) => {
  const { path } = getValidatedBody<SystemOpenRequest>(c);

  // Resolve to absolute path
  const absolutePath = resolvePath(path);

  try {
    // Check if path exists and get stats in one call
    const stats = await stat(absolutePath);
    // For files, open the containing directory
    if (stats.isFile()) {
      // Open the parent directory
      await open(dirname(absolutePath));
    } else {
      // Open the directory directly
      await open(absolutePath);
    }
    return c.json({ success: true });
  } catch (error) {
    // ENOENT means path does not exist
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new NotFoundError('Path');
    }
    const message = error instanceof Error ? error.message : 'Failed to open path';
    throw new ValidationError(message);
  }
});

export { system };
