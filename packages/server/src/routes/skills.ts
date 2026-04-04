import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { scanSkills } from '../services/skill-scanner.js';
import { git } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('skills-route');

const skills = new Hono<AppBindings>()
  .get('/', async (c) => {
    try {
      const repoRoot = (await git(['rev-parse', '--show-toplevel'], process.cwd())).trim();
      const skillList = await scanSkills(repoRoot);
      return c.json({ skills: skillList });
    } catch (err) {
      logger.warn({ err }, 'Failed to discover skills');
      return c.json({ skills: [] });
    }
  });

export { skills };
