import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { scanSkills } from '../services/skill-scanner.js';

const skills = new Hono<AppBindings>()
  .get('/', async (c) => {
    const skillList = await scanSkills(process.cwd());
    return c.json({ skills: skillList });
  });

export { skills };
