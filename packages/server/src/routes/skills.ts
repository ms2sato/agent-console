import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { scanSkills } from '../services/skill-scanner.js';
import { git } from '../lib/git.js';

const skills = new Hono<AppBindings>()
  .get('/', async (c) => {
    const repoRoot = (await git(['rev-parse', '--show-toplevel'], process.cwd())).trim();
    const skillList = await scanSkills(repoRoot);
    return c.json({ skills: skillList });
  });

export { skills };
