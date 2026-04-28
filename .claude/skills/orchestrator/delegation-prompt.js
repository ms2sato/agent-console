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

## Boundary Values (mandatory in tests)
Per \`design-principles.md\` "Specify boundary values in design briefs", initial test sets must cover boundary inputs, not just the happy path. For each contract you implement (predicate, validator, classifier, aggregator, splitter, transformer), write tests for: empty input (\`length === 0\`), single element, all-success, all-failure, mixed terminal / non-terminal. **Vacuous truth** (\`[].every() === true\`, \`[].some() === false\`) is a recurring blind-spot.

For string and chunking work specifically, also include:
- **UTF-16 surrogate pair boundary** — non-BMP code points (e.g., emoji, CJK extended) occupy two UTF-16 code units; chunkers must not split between high (\`0xD800\`-\`0xDBFF\`) and low (\`0xDC00\`-\`0xDFFF\`) surrogates.
- **Combining characters** — a base character followed by a combining mark (accent, diacritic) is one user-visible grapheme but multiple code points; preserve order.
- **Empty / single-character strings** — many off-by-one bugs surface here.

(Lesson: Sprint 2026-04-28 PR #711 — \`splitContentIntoChunks\` initial implementation passed unit tests but split surrogate pairs, broken by CodeRabbit's GitHub bot; the boundary list in this section would have caught it pre-PR.)

## 30% Checkpoint Reporting (recommended)
For non-trivial PRs (multi-file, > ~150 LOC, or ambiguous design space), pause at roughly 30% of estimated implementation and send a structured checkpoint report to the Orchestrator. Include four elements:

1. **Progress** — what is done, what remains, by file or component.
2. **Drift from expectations** — anything you encountered that differs from the Issue or your initial mental model (constraints discovered, dependencies surfaced, test fixtures missing, etc.).
3. **Recent decisions seeking confirmation** — design choices you made that the Orchestrator should sanity-check before you build further on them.
4. **Plan for the next 30%** — concrete next steps, what you expect to deliver before the next checkpoint.

The 80% checkpoint (substantially complete, awaiting verification) follows the same structure plus a Verification block: typecheck / test results in paste form, language check exit code, preflight exit code.

(Origin: cross-orchestrator knowledge sharing from conteditor CTO Sprint 17 retrospective; agent-console adopted in Sprint 2026-04-28 PR #715 — agent dogfooded both checkpoints, surfacing the existing-workflow path-ignore constraint at 30% and the language-translation scope question at 80%.)

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
