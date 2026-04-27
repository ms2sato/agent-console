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

## Architectural Invariants (required reading before implementation)
Before writing code, read \`.claude/skills/architectural-invariants/SKILL.md\` and identify which catalog entries (I-1..I-N) your change could plausibly violate. The catalog is short; walking it takes minutes.

For each applicable invariant, keep the check in mind as you implement. The Orchestrator's acceptance check (Q8) will require you to explicitly answer whether each applicable invariant holds, with evidence.

Quick reference (full details in the skill file):
- **I-1 I/O Addressing Symmetry** — if your code writes AND reads a persistent resource, the write-address and read-address must converge for the same identity (unless explicit asymmetry is documented).
- **I-2 Single Writer for Derived Values** — one function is the source-of-truth for computing paths/keys/IDs.
- **I-3 Identity Stability Across Time** — identifiers survive restart/rename/restore.
- **I-4 State Persistence Survives Process Lifecycle** — return success only after durable commit.
- **I-5 Server as Source of Truth** — user-meaningful state is not kept only in client \`localStorage\`.
- **I-6 Boundary Validation** — external values validated with a schema before use.

## Test Placement (mandatory)
For every production file you change or add, the corresponding test file **must** be placed in a sibling \`__tests__/\` directory at the same level — \`path/to/foo.ts\` → \`path/to/__tests__/foo.test.ts\`. Parent-directory placement (e.g., a test for \`services/inbound/foo.ts\` placed at \`services/__tests__/foo.test.ts\`) does **not** satisfy the \`coverage-check\` rule and will fail CI on first push. See \`testing.md\` "Test File Naming Convention".

## Key Implementation Notes
<!-- Orchestrator: Add only supplementary context NOT already in the Issue.
     Keep concise — the Issue is the source of truth.
     Examples: specific constraints, testing approach, files to avoid. -->

## Completion Steps
1. Run the FULL test suite (\`bun run test\`) and confirm ALL tests pass — not just your new tests. If any pre-existing test fails, investigate whether your changes caused it.
2. Run typecheck and confirm no errors. For client changes: \`cd packages/client && bunx tsc --noEmit\`. For server changes: \`cd packages/server && bunx tsc --noEmit\`. Skip this step for documentation-only changes.
3. Do NOT push until both step 1 and step 2 pass.
4. Run CodeRabbit CLI self-review: \`coderabbit review --agent --base main\`. Fix any CRITICAL/HIGH/MEDIUM issues before creating the PR. If CLI is not installed, skip this step.
5. Create PR: \`[AI] closed #${issueNumber} ${issue.title.replace(/^\[AI\]\s*/, '')}\`
6. Wait for CI green, fix any issues.
7. Report completion with PR URL and retrospective to Orchestrator. Your retrospective MUST include a one-line answer per applicable architectural invariant.
`;

console.log(output);
console.log(`--- Orchestrator Checklist ---
1. Customize "Key Implementation Notes" with supplementary context
2. Verify Issue #${issueNumber} has complete acceptance criteria (${criteria.length} found)
3. Keep total prompt under 5000 characters (Issue holds the details)
`);

} // end if (import.meta.main)
