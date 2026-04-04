import type { SkillDefinition } from '@agent-console/shared';
import { Glob } from 'bun';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('skill-scanner');

/**
 * Parse YAML frontmatter from a SKILL.md file content.
 * Returns null if frontmatter is missing or malformed.
 *
 * @internal Exported for testing
 */
export function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descriptionMatch) {
    return null;
  }

  return {
    name: nameMatch[1].trim(),
    description: descriptionMatch[1].trim(),
  };
}

/**
 * Scan `.claude/skills/` SKILL.md files from the given base directory
 * and return parsed skill definitions.
 *
 * @param baseDir - Repository root directory to scan from
 * @returns Sorted array of skill definitions with `/` prefixed names
 */
export async function scanSkills(baseDir: string): Promise<SkillDefinition[]> {
  const skillsDir = `${baseDir}/.claude/skills`;
  const glob = new Glob('*/SKILL.md');
  const skills: SkillDefinition[] = [];

  try {
    for await (const path of glob.scan({ cwd: skillsDir, absolute: false })) {
      const fullPath = `${skillsDir}/${path}`;
      try {
        const content = await Bun.file(fullPath).text();
        const parsed = parseFrontmatter(content);
        if (!parsed) {
          logger.warn({ path: fullPath }, 'Skipping SKILL.md with missing or malformed frontmatter');
          continue;
        }

        skills.push({
          name: `/${parsed.name}`,
          description: parsed.description,
        });
      } catch (err) {
        logger.warn({ path: fullPath, err }, 'Failed to read SKILL.md');
      }
    }
  } catch {
    // Directory does not exist or is not accessible — return empty result
    return [];
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
