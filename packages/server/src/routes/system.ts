import { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import open from 'open';
import { SystemOpenRequestSchema, SystemOpenVSCodeRequestSchema } from '@agent-console/shared';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { vValidator } from '../middleware/validation.js';
import { getSystemCapabilities } from '../services/system-capabilities-service.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';

const logger = createLogger('system-routes');

const system = new Hono()
  .get('/health', (c) => {
    return c.json({
      webhookSecretConfigured: Boolean(serverConfig.GITHUB_WEBHOOK_SECRET),
      appUrl: serverConfig.APP_URL || null,
    });
  })
  // Open a file or directory in the default application (Finder/Explorer)
  .post('/open', vValidator(SystemOpenRequestSchema), async (c) => {
    const { path } = c.req.valid('json');

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
  })
  // Open a file or directory in VS Code
  .post('/open-in-vscode', vValidator(SystemOpenVSCodeRequestSchema), async (c) => {
    const { path } = c.req.valid('json');

    // Check if VS Code is available
    const systemCapabilities = getSystemCapabilities();
    const vscodeCommand = systemCapabilities.getVSCodeCommand();

    if (!vscodeCommand) {
      throw new ValidationError('VS Code is not available on this system');
    }

    // Resolve to absolute path
    const absolutePath = resolvePath(path);

    try {
      // Check if path exists
      await stat(absolutePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundError('Path');
      }
      const message = error instanceof Error ? error.message : 'Failed to check path';
      throw new ValidationError(message);
    }

    // Launch VS Code without waiting for it to exit
    // VS Code is a long-running process, so we don't want to block
    try {
      Bun.spawn([vscodeCommand, absolutePath], {
        stdout: 'ignore',
        stderr: 'ignore',
      });

      logger.info({ path: absolutePath, command: vscodeCommand }, 'Opened path in VS Code');
      return c.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open VS Code';
      logger.error({ path: absolutePath, err: error }, 'Failed to open VS Code');
      throw new ValidationError(message);
    }
  });

export { system };
