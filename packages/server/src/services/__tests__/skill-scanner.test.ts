import { describe, it, expect } from 'bun:test';
import { parseFrontmatter, scanSkills } from '../skill-scanner.js';
import { join } from 'node:path';

describe('parseFrontmatter', () => {
  it('should parse valid frontmatter with name and description', () => {
    const content = '---\nname: orchestrator\ndescription: Orchestrator role for coordination\n---\n\n# Content';
    const result = parseFrontmatter(content);

    expect(result).toEqual({
      name: 'orchestrator',
      description: 'Orchestrator role for coordination',
    });
  });

  it('should return null when frontmatter is missing', () => {
    const content = '# Just content without frontmatter';
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('should return null when name is missing', () => {
    const content = '---\ndescription: Some description\n---\n';
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('should return null when description is missing', () => {
    const content = '---\nname: incomplete\n---\n';
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('should trim whitespace from name and description', () => {
    const content = '---\nname:   spaced-name  \ndescription:   Some description  \n---\n';
    const result = parseFrontmatter(content);

    expect(result).toEqual({
      name: 'spaced-name',
      description: 'Some description',
    });
  });

  it('should handle frontmatter with extra fields', () => {
    const content = '---\nname: test\nextra: value\ndescription: A test skill\n---\n';
    const result = parseFrontmatter(content);

    expect(result).toEqual({
      name: 'test',
      description: 'A test skill',
    });
  });
});

describe('scanSkills', () => {
  it('should return empty array for non-existent directory', async () => {
    const result = await scanSkills('/non-existent-path-that-does-not-exist');
    expect(result).toEqual([]);
  });

  it('should scan real skills directory and return sorted results with / prefix', async () => {
    // Use the actual project's .claude/skills/ directory as a known fixture
    const projectRoot = join(import.meta.dir, '..', '..', '..', '..', '..');
    const result = await scanSkills(projectRoot);

    // Verify basic structure
    expect(result.length).toBeGreaterThan(0);

    // Every entry should have a / prefix and non-empty description
    for (const skill of result) {
      expect(skill.name).toMatch(/^\//);
      expect(skill.description.length).toBeGreaterThan(0);
    }

    // Results should be sorted by name
    const names = result.map((s) => s.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);

    // Known skills from the project should be present
    expect(names).toContain('/orchestrator');
    expect(names).toContain('/backend-standards');
  });
});
