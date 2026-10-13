#!/usr/bin/env node

/**
 * Unreferenced-additions check
 *
 * A new skill script or SKILL.md can land on disk with no procedure ever
 * invoking it: present, tested, and never run because no canonical document
 * names it at the moment it should fire. This check makes the mechanical half
 * of that question (pre-pr-completeness.md Q2) a preflight verdict: every
 * ADDED subject must be named by at least one reference source.
 *
 * Subjects (added paths only; a modified file is never gated, a rename shows
 * as an add and is in scope):
 *   - `.claude/skills/**\/*.js`, excluding `__tests__/` and `*.test.js`
 *   - `.claude/skills/<skill>/SKILL.md`
 * `scripts/` (smoke scripts included) is out of scope: smokes have their own
 * registration rule in test-trigger.md.
 *
 * Key: the basename for a `.js`, the skill directory name for a `SKILL.md`.
 * Match: plain substring of the key in a reference source's text, never a
 * regex. A consequence worth stating: `foo.js` is also matched by the text
 * `foo.js.bak`; the check prefers a rare false "referenced" over a false
 * "unreferenced" that would block a legitimate PR.
 *
 * Reference sources (the canonical set):
 *   - `CLAUDE.md`, `.claude/rules/*.md`, every `.claude/skills/<skill>/SKILL.md`
 *   - `.claude/skills/orchestrator/core-responsibilities.md` and `sprint-lifecycle.md`
 *   - `.claude/agents/*.md`
 *   - the `import` / `require` lines of every OTHER non-test
 *     `.claude/skills/**\/*.js` (a library invoked by a canonical script is
 *     reachable through it)
 * A subject's own file never counts as its reference, and neither does a test
 * file. `docs/` is deliberately not a source: a design doc describing a
 * script is not an invocation point.
 *
 * Pure function over an injected `fs` -- no filesystem writes.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = '.claude/skills';

const FIXED_SUGGESTIONS = [
  '.claude/skills/orchestrator/core-responsibilities.md',
  '.claude/skills/orchestrator/sprint-lifecycle.md',
  '.claude/rules/',
];

const IMPORT_LINE_PATTERNS = [
  /^\s*import\s/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /^\s*\}?\s*from\s+['"]/,
];

function isTestJs(path) {
  return path.includes('/__tests__/') || path.endsWith('.test.js');
}

function skillOf(path) {
  // `.claude/skills/<skill>/...`
  return path.split('/')[2];
}

/** Returns `{ key, kind }` for a subject path, or null when it is not one. */
function classifySubject(path) {
  if (!path.startsWith(`${SKILLS_DIR}/`)) return null;
  const parts = path.split('/');
  if (parts.length === 4 && parts[3] === 'SKILL.md') {
    return { key: parts[2], kind: 'skill' };
  }
  if (path.endsWith('.js') && !isTestJs(path)) {
    return { key: parts[parts.length - 1], kind: 'script' };
  }
  return null;
}

function safeRead(fsImpl, absPath) {
  try {
    return fsImpl.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function safeList(fsImpl, absPath) {
  try {
    return [...fsImpl.readdirSync(absPath)].sort();
  } catch {
    return [];
  }
}

function isDirectory(fsImpl, absPath) {
  try {
    return fsImpl.lstatSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Every non-test `.js` path (repo-relative) under `.claude/skills`. */
function listSkillScripts(repoRoot, fsImpl, relDir = SKILLS_DIR) {
  const out = [];
  for (const name of safeList(fsImpl, join(repoRoot, relDir))) {
    const rel = `${relDir}/${name}`;
    if (isDirectory(fsImpl, join(repoRoot, rel))) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...listSkillScripts(repoRoot, fsImpl, rel));
    } else if (name.endsWith('.js') && !isTestJs(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function listMarkdown(repoRoot, fsImpl, relDir) {
  return safeList(fsImpl, join(repoRoot, relDir))
    .filter(name => name.endsWith('.md'))
    .map(name => `${relDir}/${name}`);
}

/** Lines of a script that import/require something -- the only part of a
 * script that counts as a reference. */
function importLines(text) {
  return text
    .split('\n')
    .filter(line => IMPORT_LINE_PATTERNS.some(pattern => pattern.test(line)))
    .join('\n');
}

/**
 * Builds `{ path, text }` for every reference source that exists. Text is
 * what a key is searched in: whole file for markdown, import lines only for
 * a script.
 */
function loadReferenceSources(repoRoot, fsImpl) {
  const markdownPaths = [
    'CLAUDE.md',
    ...listMarkdown(repoRoot, fsImpl, '.claude/rules'),
    ...safeList(fsImpl, join(repoRoot, SKILLS_DIR)).map(skill => `${SKILLS_DIR}/${skill}/SKILL.md`),
    `${SKILLS_DIR}/orchestrator/core-responsibilities.md`,
    `${SKILLS_DIR}/orchestrator/sprint-lifecycle.md`,
    ...listMarkdown(repoRoot, fsImpl, '.claude/agents'),
  ];
  const sources = [];
  for (const path of [...new Set(markdownPaths)]) {
    const text = safeRead(fsImpl, join(repoRoot, path));
    if (text !== null) sources.push({ path, text });
  }
  for (const path of listSkillScripts(repoRoot, fsImpl)) {
    const text = safeRead(fsImpl, join(repoRoot, path));
    if (text !== null) sources.push({ path, text: importLines(text) });
  }
  return sources;
}

/**
 * @param {string[]} addedFiles repo-relative paths added by the change
 * @param {string} repoRoot absolute path to the repository root
 * @param {{ readFileSync: Function, readdirSync: Function, lstatSync: Function }} [fsLike]
 * @returns {{ unreferenced: Array<{ file: string, key: string, suggestions: string[] }> }}
 */
export function checkUnreferencedAdditions(addedFiles, repoRoot, fsLike = fs) {
  const { readFileSync, readdirSync, lstatSync } = fsLike;
  const fsImpl = { readFileSync, readdirSync, lstatSync };

  const subjects = addedFiles
    .map(file => ({ file, subject: classifySubject(file) }))
    .filter(entry => entry.subject !== null);
  if (subjects.length === 0) return { unreferenced: [] };

  const sources = loadReferenceSources(repoRoot, fsImpl);
  const unreferenced = [];
  for (const { file, subject } of subjects) {
    const referenced = sources.some(
      source => source.path !== file && source.text.includes(subject.key),
    );
    if (referenced) continue;
    const [core, sprint, rules] = FIXED_SUGGESTIONS;
    const suggestions =
      subject.kind === 'script' ? [core, sprint, `${SKILLS_DIR}/${skillOf(file)}/SKILL.md`, rules] : [core, sprint, rules];
    unreferenced.push({ file, key: subject.key, suggestions });
  }
  return { unreferenced };
}

