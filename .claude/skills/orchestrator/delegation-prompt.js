#!/usr/bin/env node

/**
 * Orchestrator Delegation Message Generation Script
 *
 * Generates a structured delegation message template for worktree assignments
 * based on the Issue number. Structurally prevents omission of required sections
 * (acceptance criteria, retrospective, completion steps).
 *
 * Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number>
 */

import { execSync } from 'node:child_process';

function usage() {
  console.error(
    'Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number>'
  );
  console.error(
    'Example: node .claude/skills/orchestrator/delegation-prompt.js 42'
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

function extractAcceptanceCriteria(body) {
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

const output = `## Task Summary
Issue: ${issue.url}
${issue.title}

## Acceptance Criteria
${
  criteria.length > 0
    ? criteria.map((c) => `- [ ] ${c}`).join('\n')
    : '(No acceptance criteria found in the Issue. Orchestrator must fill in before delegating.)'
}

## Implementation Guidelines
(Orchestrator to fill in: architectural guidance, relevant files, constraints, etc.)

## Completion Steps
1. Determine the appropriate test level based on CLAUDE.md rules and Orchestrator instructions. If your judgment differs from the Orchestrator's instruction, propose with reasoning. (e.g., docs-only changes may skip tests per CLAUDE.md)
2. Run \`/review-loop\` if instructed by the Orchestrator (skip if not instructed)
3. Create PR (title: \`[AI] closed #${issueNumber} ${issue.title.replace(/^\[AI\]\s*/, '')}\`)
4. After your PR is merged, please report back to the Orchestrator with your retrospective report and the merge confirmation.
5. If you resolved an issue by communicating directly with the owner, report the following to the Orchestrator:
   - What was the problem
   - How it was resolved
   - What is needed to prevent the same issue in the future

### Retrospective Template
After PR merge, report your retrospective in the following format:

> ## Retrospective
> ### Difficulties encountered
> ### Time-consuming tasks
> ### How issues were resolved
> ### Suggestions for improvement
`;

const mcpCallExample = `## MCP Call Example
\`\`\`
delegate_to_worktree({
  repositoryId: <your AGENT_CONSOLE_REPOSITORY_ID>,
  prompt: <the full text above>,
  parentSessionId: <your AGENT_CONSOLE_SESSION_ID>,
  parentWorkerId: <your AGENT_CONSOLE_WORKER_ID>,
})
\`\`\`
`;

console.log(output);
console.log(mcpCallExample);
