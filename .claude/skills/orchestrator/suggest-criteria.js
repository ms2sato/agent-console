#!/usr/bin/env node

/**
 * Acceptance Criteria Auto-Suggest
 *
 * Analyses an Issue's title and body, matches it against the
 * architectural-invariants catalog (.claude/skills/architectural-invariants/SKILL.md)
 * using keyword and file-path heuristics, and emits suggested acceptance
 * criteria drafts that the Orchestrator can review and paste into the Issue.
 *
 * The script never edits the Issue. Matching is intentionally simple (keyword
 * + path presence). Invariants whose catalog entry does not define a
 * "Suggested acceptance criterion template" section are skipped.
 *
 * Usage: node .claude/skills/orchestrator/suggest-criteria.js <issue-number>
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CATALOG_PATH = path.resolve(
  __dirname,
  '..',
  'architectural-invariants',
  'SKILL.md'
);

/**
 * Curated matching rules per invariant id.
 *
 * keywords: lowercase substrings searched in the Issue title/body. A single
 *   hit is enough — over-matching produces a false positive the Orchestrator
 *   discards, whereas under-matching silently misses the check.
 *
 * pathFragments: substrings searched in file paths that appear verbatim in
 *   the Issue body (e.g. "packages/server/src/routes/"). Present to catch
 *   cases where the body mentions affected files but not the verbs.
 *
 * relevance: short English description emitted alongside the template when
 *   the invariant matches. Should read as a human-visible "why this applies".
 */
export const MATCHING_RULES = {
  'I-1': {
    keywords: [
      'write',
      'read',
      'persist',
      'reconnect',
      'fragment',
      'address',
      'resolver',
      'path',
      'key',
      'topic',
      'session_id',
      'session id',
      'round-trip',
      'roundtrip',
      'storage',
    ],
    pathFragments: ['database/', 'storage/', 'pty/', 'routes/'],
    relevance:
      'persistent resource written and read — write-address vs read-address must converge for the same identity',
  },
  'I-2': {
    keywords: [
      'compute',
      'derive',
      'derived',
      'helper',
      'duplicate',
      'inline',
      'path join',
      'path.join',
      'key builder',
      'formula',
      'same computation',
      'single source',
    ],
    pathFragments: [],
    relevance:
      'derived value likely computed in multiple places — needs a single exported writer',
  },
  'I-3': {
    keywords: [
      'identifier',
      'identity',
      'session_id',
      'session id',
      'uuid',
      'restart',
      'restore',
      'rename',
      'migration',
      'stable id',
      'slug',
      'primary key',
    ],
    pathFragments: ['database/migrations/'],
    relevance:
      'identifier used across time (restart / rename / migration) — must remain stable',
  },
  'I-4': {
    keywords: [
      'persist',
      'durable',
      'flush',
      'commit',
      'shutdown',
      'crash',
      'restart',
      'restore',
      'survive',
      'await',
      'fire-and-forget',
      'buffer',
    ],
    pathFragments: ['database/'],
    relevance:
      'state the user expects to survive restart — success must be returned only after durable commit',
  },
  'I-5': {
    keywords: [
      'localstorage',
      'local storage',
      'client state',
      'client-side state',
      'template',
      'draft',
      'memo',
      'preference',
      'offline',
      'optimistic',
    ],
    pathFragments: ['packages/client/'],
    relevance:
      'user-meaningful state that could leak into client-only storage — server must be the source of truth',
  },
  'I-6': {
    keywords: [
      'validate',
      'validation',
      'schema',
      'valibot',
      'parse',
      'json.parse',
      'payload',
      'untrusted',
      'external api',
      'boundary',
      'input',
      'user input',
      'corrupt',
    ],
    pathFragments: ['routes/', 'database/', 'ipc/'],
    relevance:
      'value crossing a trust boundary — must be schema-validated before use',
  },
  'I-7': {
    keywords: [
      'shape',
      'shapes',
      'variant',
      'variants',
      'enumeration',
      'exhaustive',
      'exhaustiveness',
      'discriminated union',
      'default branch',
      'default case',
      'fallback',
      'optional prefix',
      'org/repo',
      'protocol-relative',
      'either',
    ],
    pathFragments: [],
    relevance:
      'value has multiple valid shapes — every code path and test must cover all shapes; no silent fallback to a single default',
  },
  'I-8': {
    keywords: [
      'install',
      'installer',
      'postinstall',
      'symlink',
      'git hook',
      'commit-msg',
      'pre-commit',
      'daemon',
      'systemd',
      'launchd',
      'package metadata',
      'embedded reference',
      'embedded path',
      'dangling',
      'cwd-anchored',
      'worktree-anchored',
      'artifact lifetime',
      'shared resource',
      'git-common-dir',
    ],
    pathFragments: ['scripts/install', 'hooks/', 'git-hooks/'],
    relevance:
      'artifact written to a shared / persistent location — embedded references must resolve via globally-stable anchors, not cwd or per-worktree paths',
  },
};

function usage() {
  console.error(
    'Usage: node .claude/skills/orchestrator/suggest-criteria.js <issue-number>'
  );
  process.exit(1);
}

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getIssue(issueNumber) {
  const result = exec(
    `gh issue view ${issueNumber} --json number,title,body,url --jq '{number: .number, title: .title, body: .body, url: .url}'`
  );
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Parse the architectural-invariants SKILL.md into per-invariant entries.
 *
 * Returns an array of { id, name, template } in catalog order. Entries that
 * do not define a "Suggested acceptance criterion template" section have
 * template === null and are filtered by the caller.
 */
export function parseCatalog(content) {
  const lines = content.split('\n');
  const entries = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^## (I-\d+)\. (.+)$/);
    if (header) {
      if (current) entries.push(current);
      current = { id: header[1], name: header[2].trim(), body: [] };
      continue;
    }
    // Stop collecting when we hit a non-invariant top-level section.
    if (/^## /.test(line) && current) {
      entries.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(current);

  return entries.map(({ id, name, body }) => ({
    id,
    name,
    template: extractTemplate(body.join('\n')),
  }));
}

function extractTemplate(entryBody) {
  const match = entryBody.match(
    /### Suggested acceptance criterion template\s*\n([\s\S]+?)(?=\n### |\n---|\n## |$)/
  );
  if (!match) return null;
  return match[1].trim();
}

/**
 * Extract lowercase text and referenced file paths from an Issue body.
 *
 * File-path extraction is deliberately loose: any backtick-wrapped token or
 * bare token containing "/" and at least one common source-tree fragment
 * ("packages/", "src/", ".claude/") counts.
 */
export function analyzeIssue(issue) {
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;
  const lowered = text.toLowerCase();

  const paths = new Set();
  const pathRegex = /[`"\s(]((?:packages|src|\.claude|scripts|docs)\/[\w@.\-/]*)/g;
  let m;
  while ((m = pathRegex.exec(text)) !== null) {
    paths.add(m[1]);
  }

  return { text, lowered, paths: [...paths] };
}

/**
 * Match an analysed Issue against the catalog. Pure function — returns data,
 * does not print. Ordered by catalog id so output is deterministic.
 */
export function matchInvariants(analysis, catalog, rules = MATCHING_RULES) {
  const matches = [];
  for (const entry of catalog) {
    if (!entry.template) continue;
    const rule = rules[entry.id];
    if (!rule) continue;

    const hitKeywords = rule.keywords.filter(k => analysis.lowered.includes(k));
    const hitPaths = rule.pathFragments.filter(p =>
      analysis.paths.some(ip => ip.includes(p))
    );

    if (hitKeywords.length === 0 && hitPaths.length === 0) continue;

    matches.push({
      id: entry.id,
      name: entry.name,
      relevance: rule.relevance,
      hitKeywords,
      hitPaths,
      template: entry.template,
    });
  }
  return matches;
}

export function formatReport(issue, analysis, matches) {
  const lines = [];
  lines.push(`Issue #${issue.number}: ${issue.title}`);
  lines.push('');
  lines.push('Analyzed:');
  lines.push(`- title/body length: ${analysis.text.length} chars`);
  if (analysis.paths.length > 0) {
    lines.push(`- affected paths (from body): ${analysis.paths.join(', ')}`);
  } else {
    lines.push('- affected paths (from body): (none detected)');
  }
  lines.push('');

  if (matches.length === 0) {
    lines.push(
      'No matches — verify this Issue intentionally does not interact with any catalog invariant.'
    );
    lines.push('');
    lines.push(
      'If it should, review `.claude/skills/architectural-invariants/SKILL.md` manually.'
    );
    return lines.join('\n');
  }

  lines.push('Suggested acceptance criteria mapped to architectural-invariants:');
  lines.push('');
  for (const m of matches) {
    lines.push(`[${m.id} ${m.name}]`);
    const signalParts = [];
    if (m.hitKeywords.length > 0) {
      signalParts.push(`keywords: ${m.hitKeywords.join(', ')}`);
    }
    if (m.hitPaths.length > 0) {
      signalParts.push(`paths: ${m.hitPaths.join(', ')}`);
    }
    lines.push(`  Signals: ${signalParts.join(' | ')}`);
    lines.push(`  Relevance: ${m.relevance}`);
    lines.push('  Suggested criterion:');
    for (const tl of m.template.split('\n')) {
      lines.push(`    ${tl}`);
    }
    lines.push('');
  }
  lines.push(
    'Orchestrator review: paste approved criteria into the Issue, adjust wording for the concrete change.'
  );
  return lines.join('\n');
}

export function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  return readFileSync(catalogPath, 'utf-8');
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('suggest-criteria.js');

if (isMainModule) {
  const issueNumber = process.argv[2];
  if (!issueNumber || !/^\d+$/.test(issueNumber)) {
    usage();
  }

  const issue = getIssue(issueNumber);
  if (!issue) {
    console.error(
      `Error: Issue #${issueNumber} not found. Verify the issue number and gh authentication.`
    );
    process.exit(1);
  }

  const catalogContent = loadCatalog();
  const catalog = parseCatalog(catalogContent);
  const analysis = analyzeIssue(issue);
  const matches = matchInvariants(analysis, catalog);
  console.log(formatReport(issue, analysis, matches));
}
