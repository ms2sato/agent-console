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
 *     PR's current head SHA
 *   - surface 4 (commit-status description): `Review completed` is the
 *     clean state; everything else (including the documented
 *     `Review skipped: ...` / `Review rate limited` shapes) is not
 */

import { exec } from './check-utils.js';

/**
 * @param {string|number} prNumber
 * @param {{ execImpl?: typeof exec }} [opts]
 * @returns {{
 *   state: 'reviewed' | 'unreviewed' | 'retrieval-failed',
 *   headSha: string | null,
 *   matchingReviewAt: string | null,
 *   statusDescription: string | null,
 *   dispositionRecorded: boolean,
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
  const dispositionRecorded = /coderabbit disposition/i.test(body);
  if (!headSha) {
    return makeResult({ state: 'retrieval-failed', dispositionRecorded });
  }

  // Surface 5/6's underlying data: the PR's reviews, filtered to the bot.
  // The bot's login is `coderabbitai[bot]` — an equality compare against
  // `coderabbitai` is the documented false-empty (SKILL.md "Two ways the
  // query itself lies to you"); `startsWith` is required.
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

  const botReviews = reviews.filter(
    (r) => typeof r?.user?.login === 'string' && r.user.login.startsWith('coderabbitai'),
  );
  const matchingReview = botReviews.find((r) => r.commit_id === headSha);
  const matchingReviewAt = typeof matchingReview?.submitted_at === 'string' ? matchingReview.submitted_at : null;

  const reviewed = Boolean(matchingReview) || statusDescription === 'Review completed';

  return makeResult({
    state: reviewed ? 'reviewed' : 'unreviewed',
    headSha,
    matchingReviewAt,
    statusDescription,
    dispositionRecorded,
  });
}

function makeResult({ state, headSha = null, matchingReviewAt = null, statusDescription = null, dispositionRecorded = false }) {
  return { state, headSha, matchingReviewAt, statusDescription, dispositionRecorded };
}
