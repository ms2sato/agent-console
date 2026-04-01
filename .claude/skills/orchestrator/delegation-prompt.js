#!/usr/bin/env node

/**
 * Orchestrator Delegation Message Generation Script
 *
 * Generates a concise delegation prompt that references the Issue as the source of truth.
 * The prompt contains only: Issue URL, supplementary notes placeholder, and completion steps.
 * All design details, acceptance criteria, and affected files live in the Issue itself.
 *
 * This avoids the 5000-char prompt limit by keeping the prompt lean.
 *
 * Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number>
 */

import { execSync } from 'node:child_process';

function usage() {
  console.error(
    'Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number>'
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

function getIssue(issueNumber) {
  const result = exec(
    `gh issue view ${issueNumber} --json title,body,url --jq '{title: .title, body: .body, url: .url}'`
  );
  if (!result) {
    return null;
  }
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

export function extractAcceptanceCriteria(body) {
  if (!body) return [];
  const lines = body.split('\n');
  const criteria = [];
  for (const line of lines) {
    const match = line.match(/^- \[ \]\s+(.+)/);
    if (match) {
      criteria.push(match[1].trim());
    }
  }
  return criteria;
}

// --- Main ---

// Skip main logic when imported as a module (e.g., from tests)
if (!import.meta.main) {
  // noop: only exports are used
} else {

const issueNumber = process.argv[2];
if (!issueNumber || !/^\d+$/.test(issueNumber)) {
  usage();
}

const issue = getIssue(issueNumber);
if (!issue) {
  console.error(
    `Error: Issue #${issueNumber} not found. Please verify the issue number and gh command authentication.`
  );
  process.exit(1);
}

const criteria = extractAcceptanceCriteria(issue.body);

if (criteria.length === 0) {
  console.error(
    `⚠ WARNING: No acceptance criteria found in Issue #${issueNumber}.`
  );
  console.error(
    '  Orchestrator must fill in acceptance criteria in the Issue before delegating.'
  );
}

const output = `## Task
Issue: ${issue.url}
${issue.title}

Read the Issue carefully — it contains the full design, acceptance criteria, and affected files list.

## Key Implementation Notes
<!-- Orchestrator: Add only supplementary context NOT already in the Issue.
     Keep concise — the Issue is the source of truth.
     Examples: specific constraints, testing approach, files to avoid. -->

## Completion Steps
1. Run CodeRabbit CLI self-review if installed: \`coderabbit review --agent --base main\`
2. Create PR: \`[AI] closed #${issueNumber} ${issue.title.replace(/^\[AI\]\s*/, '')}\`
3. Wait for CI green, fix any issues.
4. Report completion with PR URL and retrospective to Orchestrator.
`;

console.log(output);
console.log(`--- Orchestrator Checklist ---
1. Customize "Key Implementation Notes" with supplementary context
2. Verify Issue #${issueNumber} has complete acceptance criteria (${criteria.length} found)
3. Keep total prompt under 5000 characters (Issue holds the details)
`);

} // end if (import.meta.main)
