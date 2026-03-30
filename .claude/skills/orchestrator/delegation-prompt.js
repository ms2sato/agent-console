#!/usr/bin/env node

/**
 * Orchestrator Delegation Message Generation Script
 *
 * Generates a structured delegation message template for worktree assignments
 * based on the Issue number. Structurally prevents omission of required sections
 * (acceptance criteria, retrospective, completion steps).
 *
 * Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number> [--validate]
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function usage() {
  console.error(
    'Usage: node .claude/skills/orchestrator/delegation-prompt.js <Issue number> [--validate]'
  );
  console.error(
    '  Generate mode: node .claude/skills/orchestrator/delegation-prompt.js 42'
  );
  console.error(
    '  Validate mode: echo "$PROMPT_TEXT" | node .claude/skills/orchestrator/delegation-prompt.js 42 --validate'
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

function extractSection(text, sectionName) {
  const pattern = new RegExp(
    `### ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n###|\\n##[^#]|$)`
  );
  const match = text.match(pattern);
  if (!match) return null;
  // Remove HTML comments and trim
  return match[1].replace(/<!--.*?-->/g, '').trim();
}

function validate(text) {
  const errors = [];

  const affectedFiles = extractSection(text, 'Affected Files');
  if (affectedFiles === null) {
    errors.push('Missing "### Affected Files" section');
  } else {
    if (affectedFiles.includes('path/to/file.ts')) {
      errors.push(
        '"Affected Files" contains placeholder path (path/to/file.ts)'
      );
    }
    if (!/`[^`]*\/[^`]*`/.test(affectedFiles)) {
      errors.push(
        '"Affected Files" must include at least one specific file path in backticks'
      );
    }
  }

  const keyFunctions = extractSection(text, 'Key Functions/Types');
  if (!keyFunctions) {
    errors.push('"Key Functions/Types" section is empty or missing');
  }

  const constraints = extractSection(text, 'Constraints');
  if (!constraints) {
    errors.push('"Constraints" section is empty or missing');
  }

  const testingApproach = extractSection(text, 'Testing Approach');
  if (!testingApproach) {
    errors.push('"Testing Approach" section is empty or missing');
  }

  return errors;
}

// --- Main ---

const issueNumber = process.argv[2];
if (!issueNumber || !/^\d+$/.test(issueNumber)) {
  usage();
}

const validateMode = process.argv[3] === '--validate';

if (validateMode) {
  const input = readFileSync('/dev/stdin', 'utf-8');
  const errors = validate(input);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✗ ${error}`);
    }
    process.exit(1);
  }
  console.log('✓ Validation passed');
  process.exit(0);
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

### Affected Files
<!-- List each file with: current behavior → required change -->
- \`path/to/file.ts\`: [current] → [change]

### Key Functions/Types
<!-- Function signatures or type definitions that will change -->

### Constraints
<!-- What NOT to change, backward compatibility, scope boundaries -->

### Testing Approach
<!-- Which test files to update, what new tests to add -->

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
console.log(`⚠ IMPORTANT: Fill in ALL sections under "Implementation Guidelines" before delegating.
  Required sections: Affected Files, Key Functions/Types, Constraints, Testing Approach
  Each "Affected Files" entry must include a specific file path (not placeholder).
`);
