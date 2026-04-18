#!/usr/bin/env node

/**
 * Brewing context packager — Architectural Invariants
 *
 * Prepares structured context for a Claude session (typically the Orchestrator,
 * or a sub-agent dispatched via `delegate_to_worktree`) to evaluate whether a
 * merged PR warrants a new architectural-invariant proposal.
 *
 * This script is PURE CONTEXT ASSEMBLY — it does NOT call any LLM. Judgment is
 * performed by the invoking Claude, which reads the output and applies the
 * rubric in `.claude/skills/brewing/SKILL.md`. Keeping LLM calls out of the
 * script preserves the subscription-auth economic model: only the invoking
 * Claude (Orchestrator or sub-agent with its own auth) consumes tokens.
 *
 * Usage:
 *   node .claude/skills/orchestrator/brew-invariants.js <PR number>
 *   node .claude/skills/orchestrator/brew-invariants.js 638 > /tmp/brew-638.md
 *
 * Runtime: standard ESM + `node:child_process` + `node:fs` only. Compatible
 * with both Node.js (≥20, tested on v24) and Bun (the project's declared
 * engine). The entry-point check below uses a Node-compatible pattern so
 * either runner works.
 *
 * Output: structured markdown on stdout. Redirect to a file, or let the caller
 * pipe into a Claude session / sub-agent prompt.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_DIFF_LINES = 500;

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    console.error(`Command failed: ${cmd}\n${err.message}`);
    return null;
  }
}

function usage() {
  console.error('Usage: node .claude/skills/orchestrator/brew-invariants.js <PR number>');
  process.exit(1);
}

function tryRead(relPath) {
  try {
    return readFileSync(resolve(process.cwd(), relPath), 'utf-8');
  } catch {
    return null;
  }
}

export function truncate(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n\n[... ${lines.length - maxLines} more lines truncated. Fetch full diff with \`gh pr diff <PR>\`.]`;
}

export function extractLinkedIssueNumber(prBody) {
  if (!prBody) return null;
  const match = prBody.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return match ? match[1] : null;
}

function main() {
  const prNumber = process.argv[2];
  if (!prNumber || !/^\d+$/.test(prNumber)) usage();

  // PR metadata (title, body, URL, merge info, author)
  const prMetaRaw = exec(`gh pr view ${prNumber} --json number,title,body,url,mergedAt,author`);
  if (!prMetaRaw) {
    console.error(`Could not fetch PR #${prNumber}. Check PR number and gh auth.`);
    process.exit(1);
  }

  let prMeta;
  try {
    prMeta = JSON.parse(prMetaRaw);
  } catch (err) {
    console.error(`Failed to parse gh output for PR #${prNumber}: ${err.message}`);
    process.exit(1);
  }

  // Full diff, truncated for context hygiene.
  // If the fetch fails, surface the error visibly in the output rather than
  // silently substituting a placeholder — a judging Claude that cannot tell
  // the difference between "empty diff" and "fetch failed" may propose or
  // skip for the wrong reason.
  const prDiffRaw = exec(`gh pr diff ${prNumber}`);
  const prDiff = prDiffRaw !== null
    ? prDiffRaw
    : `⚠ Failed to fetch diff for PR #${prNumber}. \`gh pr diff ${prNumber}\` returned no output. The brewing judgment below may be unreliable — retry after verifying gh auth, or run \`gh pr diff ${prNumber}\` manually to diagnose.`;
  const truncatedDiff = truncate(prDiff, MAX_DIFF_LINES);

  // Linked Issue detection (closes / fixes / resolves).
  // Same principle as the diff: if the linked issue fetch fails, make the
  // failure visible so the judge does not silently proceed with missing
  // context.
  let issueSection = '';
  const issueNumber = extractLinkedIssueNumber(prMeta.body);
  if (issueNumber) {
    const issueRaw = exec(`gh issue view ${issueNumber} --json number,title,body`);
    if (issueRaw === null) {
      issueSection = [
        '',
        `## Linked Issue #${issueNumber}`,
        '',
        `⚠ Failed to fetch Issue #${issueNumber}. \`gh issue view ${issueNumber}\` returned no output. The brewing judgment below may be missing intent/context from the linked Issue — retry after verifying gh auth, or fetch the Issue manually.`,
        '',
      ].join('\n');
    } else {
      try {
        const issue = JSON.parse(issueRaw);
        issueSection = [
          '',
          `## Linked Issue #${issue.number}: ${issue.title}`,
          '',
          issue.body || '(empty body)',
          '',
        ].join('\n');
      } catch (err) {
        issueSection = [
          '',
          `## Linked Issue #${issueNumber}`,
          '',
          `⚠ Failed to parse Issue #${issueNumber} response as JSON: ${err.message}. The brewing judgment below may be missing intent/context from the linked Issue.`,
          '',
        ].join('\n');
      }
    }
  }

  // Existence check for the brewing skill and catalog (helpful if user runs
  // the script in a repo that hasn't adopted brewing yet)
  const brewingSkillPresent = tryRead('.claude/skills/brewing/SKILL.md') !== null;
  const catalogPresent = tryRead('.claude/skills/architectural-invariants/SKILL.md') !== null;

  // Output
  const lines = [];
  lines.push(`# Brewing Context — PR #${prMeta.number}: ${prMeta.title}`);
  lines.push('');
  lines.push('You are the **judge** in a brewing session. Apply the rubric in');
  lines.push('`.claude/skills/brewing/SKILL.md` to the context below.');
  lines.push('');
  lines.push('- If ALL four catalog criteria hold, write a proposal to');
  lines.push('  `docs/context-store/_proposals/I-<next>-<slug>-pr<PR>.md`');
  lines.push('  using the template in the brewing skill.');
  lines.push('- Otherwise, record: `skip: PR #<N> — <reason>: <explanation>`');
  lines.push('');
  lines.push('Before writing a proposal, **read**:');
  lines.push('1. `.claude/skills/brewing/SKILL.md` — the rubric');
  lines.push('2. `.claude/skills/architectural-invariants/SKILL.md` — the catalog (avoid duplicates)');
  lines.push('3. `docs/context-store/_proposals/` and `docs/context-store/_rejected/` — avoid re-proposing');
  lines.push('');
  if (!brewingSkillPresent) {
    lines.push('> ⚠ `.claude/skills/brewing/SKILL.md` not found in this repo. Brewing may not be set up yet.');
    lines.push('');
  }
  if (!catalogPresent) {
    lines.push('> ⚠ `.claude/skills/architectural-invariants/SKILL.md` not found in this repo. Catalog not set up.');
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('## PR Metadata');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(prMeta, null, 2));
  lines.push('```');
  if (issueSection) {
    lines.push(issueSection);
  }
  lines.push('');
  lines.push(`## PR Diff (first ${MAX_DIFF_LINES} lines)`);
  lines.push('');
  lines.push('```diff');
  lines.push(truncatedDiff);
  lines.push('```');

  console.log(lines.join('\n'));
}

// Entry-point check that works on both Node (import.meta.url === file://<arg0>)
// and Bun (import.meta.main is true). Node ≥20 and Bun both support ESM with
// `import.meta.url`; preflight-check.js uses the same pattern.
const isMainModule =
  import.meta.main === true ||
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('brew-invariants.js');

if (isMainModule) {
  main();
}
