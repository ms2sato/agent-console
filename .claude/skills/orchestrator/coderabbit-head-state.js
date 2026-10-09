/**
 * CodeRabbit head-review-state detection.
 *
 * A CodeRabbit disposition ("this PR's unreviewed delta is covered by
 * compensating control X, recorded at Y") was previously something an
 * Orchestrator remembered to write, not something the acceptance check
 * required. This module answers the one mechanical question that makes
 * the record a precondition rather than an accompaniment: has CodeRabbit
 * actually reviewed this PR's CURRENT head, and if not, did anyone record
 * a disposition in the PR body?
 *
 * Deliberately a standalone module, not an addition to check-utils.js, so
 * it stays disjoint from unrelated concurrent edits to that file.
 *
 * The three `gh` calls below and their verdict shapes mirror
 * `.claude/skills/coderabbit-ops/SKILL.md`'s documented surfaces:
 *   - surface 6 (review freshness): a review whose `commit_id` equals the
 *     PR's current head SHA AND whose body is a real review PASS -- not
 *     merely a review object attached to the head. CodeRabbit also creates
 *     empty-body review objects when it acknowledges a thread resolution
 *     ("Thanks for the fix ... Review thread resolved"), and those carry
 *     `commit_id` = the current head too. A bare `commit_id` match reads
 *     an unreviewed head as reviewed whenever CodeRabbit happened to post
 *     such an ack on it, even while the commit status for that head reads
 *     something other than "Review completed".
 *   - surface 4 (commit-status description): `Review completed` is the
 *     clean state; everything else (including the documented
 *     `Review skipped: ...` / `Review rate limited` shapes) is not
 */

import { exec } from './check-utils.js';

/**
 * A head review counts as a review PASS only when its body carries the
 * positive "Actionable comments posted" marker (case-insensitive,
 * anywhere in the body -- not anchored to the start, since the marker can
 * follow an autofix HTML comment block in some real bodies). An empty or
 * unmarked body on the head is CodeRabbit's thread-resolution ACK, not a
 * review of the head.
 *
 * The predicate is deliberately a POSITIVE marker check, not "body is
 * non-empty": a real review can have a non-empty body with no actionable
 * findings and no count-style marker at all (an observed nitpick-only
 * review shape), and that must still NOT be mistaken for a pass -- a
 * nitpick-only review is still a genuine ack for THIS check's purposes
 * (it gives Q13 no exemption), and the absent marker correctly falls to
 * 'unreviewed' (the safe direction) rather than risking a false
 * 'reviewed' on some other non-empty body shape. When the marker is
 * absent, `reviewed` falls to `unreviewed` and Q13 is asked, loud.
 *
 * @param {{ body?: unknown }} review
 * @returns {boolean}
 */
function isReviewPass(review) {
  return typeof review?.body === 'string' && /\bActionable comments posted\b/i.test(review.body);
}

/**
 * @param {string|number} prNumber
 * @param {{ execImpl?: typeof exec }} [opts]
 * @returns {{
 *   state: 'reviewed' | 'unreviewed' | 'retrieval-failed',
 *   headSha: string | null,
 *   matchingReviewAt: string | null,
 *   statusDescription: string | null,
 *   dispositionRecorded: boolean,
 *   headReviewCount: number,
 *   headAckCount: number,
 * }}
 */
export function getCodeRabbitHeadState(prNumber, { execImpl = exec } = {}) {
  const prJson = execImpl(`gh pr view ${prNumber} --json headRefOid,body`);
  if (!prJson) {
    return makeResult({ state: 'retrieval-failed' });
  }
  let pr;
  try {
    pr = JSON.parse(prJson);
  } catch {
    return makeResult({ state: 'retrieval-failed' });
  }
  const headSha = typeof pr?.headRefOid === 'string' && pr.headRefOid.length > 0 ? pr.headRefOid : null;
  const body = typeof pr?.body === 'string' ? pr.body : '';
  // The disposition marker is read from the body regardless of what happens
  // below — even a `retrieval-failed` run should report whether a record
  // already exists, since that is orthogonal to whether the three `gh`
  // calls themselves succeeded.
  //
  // The marker must be an actual Markdown HEADING, not merely the words
  // appearing somewhere in the body: a prose sentence like "No CodeRabbit
  // disposition has been recorded" would otherwise satisfy the check it is
  // describing the absence of.
  const dispositionRecorded = /^#{1,6}\s+CodeRabbit disposition\b/im.test(body);
  if (!headSha) {
    return makeResult({ state: 'retrieval-failed', dispositionRecorded });
  }

  // Surface 5/6's underlying data: the PR's reviews, filtered to the bot.
  // The bot's login must be matched by the EXACT string "coderabbitai[bot]":
  // a bare equality compare against "coderabbitai" is the documented
  // false-empty (SKILL.md "Two ways the query itself lies to you") because
  // the real bot account always carries the "[bot]" suffix -- but a PREFIX
  // match (`startsWith('coderabbitai')`) over-corrects and also admits a
  // lookalike human account such as `coderabbitai-helper`, which any
  // public-repository commenter could register. Matching the full exact
  // string avoids both failure modes.
  //
  // `--paginate` is required: GitHub's default page size is 30 reviews, so
  // on a PR with many review rounds the review matching the current head
  // can be on a later page, silently dropped by an unpaginated call. Plain
  // `--paginate` concatenates each page's JSON array one after another in
  // the output, which `JSON.parse` cannot read; `--slurp` wraps the pages
  // into one JSON array of arrays instead, so the result below is always
  // an array of page-arrays (even a single page comes back as `[[...]]`).
  const reviewsJson = execImpl(`gh api --paginate --slurp repos/{owner}/{repo}/pulls/${prNumber}/reviews`);
  if (!reviewsJson) {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }
  let reviewPages;
  try {
    reviewPages = JSON.parse(reviewsJson);
  } catch {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }
  if (!Array.isArray(reviewPages)) {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }
  const reviews = reviewPages.flat();

  // Surface 4's underlying data: the `CodeRabbit` commit-status entry for
  // this exact head SHA, read for its `description`.
  const statusJson = execImpl(`gh api repos/{owner}/{repo}/commits/${headSha}/status`);
  if (!statusJson) {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }
  let statusObj;
  try {
    statusObj = JSON.parse(statusJson);
  } catch {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }
  const statuses = Array.isArray(statusObj?.statuses) ? statusObj.statuses : null;
  if (statuses === null) {
    return makeResult({ state: 'retrieval-failed', headSha, dispositionRecorded });
  }

  const crEntry = statuses.find((s) => s?.context === 'CodeRabbit');
  const statusDescription = typeof crEntry?.description === 'string' ? crEntry.description : null;

  const botReviews = reviews.filter((r) => r?.user?.login === 'coderabbitai[bot]');
  // All bot review objects attached to the current head -- real passes AND
  // empty-body thread-resolution acks alike. `reviewPass` narrows this to
  // the one (if any) that is an actual review of the head; everything else
  // in `headReviews` is an ack, counted separately below.
  const headReviews = botReviews.filter((r) => r.commit_id === headSha);
  const reviewPass = headReviews.find(isReviewPass);
  const matchingReviewAt = typeof reviewPass?.submitted_at === 'string' ? reviewPass.submitted_at : null;
  const headReviewCount = headReviews.length;
  const headAckCount = headReviews.filter((r) => !isReviewPass(r)).length;

  const reviewed = Boolean(reviewPass) || statusDescription === 'Review completed';

  return makeResult({
    state: reviewed ? 'reviewed' : 'unreviewed',
    headSha,
    matchingReviewAt,
    statusDescription,
    dispositionRecorded,
    headReviewCount,
    headAckCount,
  });
}

function makeResult({
  state,
  headSha = null,
  matchingReviewAt = null,
  statusDescription = null,
  dispositionRecorded = false,
  headReviewCount = 0,
  headAckCount = 0,
}) {
  return { state, headSha, matchingReviewAt, statusDescription, dispositionRecorded, headReviewCount, headAckCount };
}
