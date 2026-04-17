#!/usr/bin/env node

/**
 * Rule/Skill Duplication Check
 *
 * Enforces the invariant from .claude/README.md:
 *   "Rule prose must not appear verbatim in any skill file."
 *
 * Scans every paragraph in .claude/rules/*.md and reports any paragraph
 * whose normalized form also appears in a .claude/skills/**\/*.md file.
 *
 * Exits 0 if no duplication, 1 if any rule paragraph leaked into a skill.
 *
 * Usage:
 *   node .claude/skills/orchestrator/rule-skill-duplication-check.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RULES_DIR = join(REPO_ROOT, '.claude/rules');
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');

/** Minimum length of a rule paragraph to consider for duplication. Shorter
 * fragments produce too many false positives (common one-liners, shared
 * headings). 80 chars empirically balances recall and precision. */
const MIN_PARAGRAPH_LENGTH = 80;

// --- Filesystem helpers ---

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

// --- Paragraph extraction ---

/** Remove YAML frontmatter from a markdown body. */
function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** Remove fenced code blocks — code is tolerated in both rule and skill. */
function stripCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

/** Normalize a paragraph for comparison: collapse whitespace, strip markdown
 * emphasis marks that are likely to drift between copies. */
function normalize(text) {
  return text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract candidate paragraphs from a markdown file body. A paragraph is a
 * blank-line-separated block that: is long enough, is not purely a heading,
 * and is not purely a list of table pipes. */
function extractParagraphs(content) {
  const body = stripCodeBlocks(stripFrontmatter(content));
  const blocks = body.split(/\n\s*\n/);
  const paragraphs = [];
  for (const raw of blocks) {
    const text = raw.trim();
    if (text.length < MIN_PARAGRAPH_LENGTH) continue;
    if (/^#+\s/.test(text)) continue; // heading block
    if (/^\|[\s\S]*\|$/.test(text) && !/[a-zA-Z]{20,}/.test(text)) continue; // table shell
    const normalized = normalize(text);
    if (normalized.length < MIN_PARAGRAPH_LENGTH) continue;
    paragraphs.push({ original: text, normalized });
  }
  return paragraphs;
}

// --- Main ---

/** Scan all rule files and find paragraphs that appear in any skill file.
 * Returns an array of violations (empty if none). */
export function findDuplications() {
  const ruleFiles = walk(RULES_DIR);
  const skillFiles = walk(SKILLS_DIR);

  const skillContent = new Map();
  for (const skillPath of skillFiles) {
    const raw = readFileSync(skillPath, 'utf-8');
    skillContent.set(skillPath, normalize(stripCodeBlocks(stripFrontmatter(raw))));
  }

  const violations = [];

  for (const rulePath of ruleFiles) {
    const raw = readFileSync(rulePath, 'utf-8');
    const paragraphs = extractParagraphs(raw);
    for (const { original, normalized } of paragraphs) {
      for (const [skillPath, skillBody] of skillContent) {
        if (skillBody.includes(normalized)) {
          violations.push({
            rulePath: relative(REPO_ROOT, rulePath),
            skillPath: relative(REPO_ROOT, skillPath),
            excerpt: original.slice(0, 120).replace(/\n/g, ' '),
          });
          break;
        }
      }
    }
  }

  return violations;
}

export function run() {
  const violations = findDuplications();

  console.log('## Rule/Skill Duplication Check\n');

  if (violations.length === 0) {
    console.log('✅ No rule paragraphs found verbatim in any skill file.');
    return 0;
  }

  console.log(`❌ Found ${violations.length} rule paragraph(s) duplicated in skill files:\n`);
  for (const v of violations) {
    console.log(`- rule: \`${v.rulePath}\``);
    console.log(`  skill: \`${v.skillPath}\``);
    console.log(`  excerpt: "${v.excerpt}..."`);
    console.log();
  }
  console.log('Resolve by keeping the rule as canonical and replacing the skill copy with a cross-reference (see `.claude/README.md`).');
  return 1;
}

// --- Entry point ---

const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('rule-skill-duplication-check.js');
if (isMainModule) {
  process.exit(run());
}
