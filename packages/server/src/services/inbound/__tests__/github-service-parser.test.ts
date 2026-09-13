import { describe, expect, it } from 'bun:test';
import { GitHubServiceParser } from '../github-service-parser.js';

describe('GitHubServiceParser: issues event dispatch', () => {
  const parser = new GitHubServiceParser('secret-token');
  const issuesHeaders = new Headers({ 'x-github-event': 'issues' });

  // ---------- Regression: `closed` must remain byte-identical after the
  // `parseIssue` dispatch refactor (the real risk of this refactor is
  // "closed stops working", not "labeled doesn't work"). ----------

  it('parses issue closed events unchanged by the parseIssue dispatch refactor', async () => {
    const payload = JSON.stringify({
      action: 'closed',
      issue: {
        number: 42,
        title: 'Fix bug',
        html_url: 'https://example.com/issues/42',
      },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).not.toBeNull();
    expect(event!.type).toBe('issue:closed');
    expect(event!.source).toBe('github');
    expect(event!.metadata.repositoryName).toBe('owner/repo');
    expect(event!.metadata.url).toBe('https://example.com/issues/42');
    expect(event!.summary).toBe('Issue #42 closed: Fix bug');
  });

  // ---------- opened (with labels present at creation) ----------

  it('parses an opened issue with labels into issue:labeled carrying the full label set', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 100,
        title: 'New feature request',
        html_url: 'https://example.com/issues/100',
        updated_at: '2024-06-01T12:00:00Z',
        labels: [{ name: 'enhancement' }, { name: 'needs-triage' }],
      },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).not.toBeNull();
    expect(event!.type).toBe('issue:labeled');
    expect(event!.metadata.repositoryName).toBe('owner/repo');
    expect(event!.metadata.labels).toEqual(['enhancement', 'needs-triage']);
    expect(event!.summary).toContain('#100');
    expect(event!.summary).toContain('enhancement');
  });

  it('returns null for an opened issue with an empty label set (vacuous boundary)', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 101,
        title: 'No labels yet',
        labels: [],
      },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });

  // ---------- labeled (a single label added to an existing issue) ----------

  it('parses a labeled issue into issue:labeled carrying only the single ADDED label', async () => {
    const payload = JSON.stringify({
      action: 'labeled',
      label: { name: 'orchestrator-trigger' },
      issue: {
        number: 200,
        title: 'Existing issue',
        html_url: 'https://example.com/issues/200',
        updated_at: '2024-06-02T00:00:00Z',
      },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).not.toBeNull();
    expect(event!.type).toBe('issue:labeled');
    expect(event!.metadata.labels).toEqual(['orchestrator-trigger']);
    expect(event!.summary).toBe("Issue #200 labeled 'orchestrator-trigger': Existing issue");
  });

  // ---------- unrecognized action ----------

  it('returns null for an unrecognized issues action', async () => {
    const payload = JSON.stringify({
      action: 'reopened',
      issue: { number: 1, title: 'Some issue' },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });

  it('returns null when the payload has no recognizable action field at all', async () => {
    const payload = JSON.stringify({
      issue: { number: 1, title: 'Some issue' },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });

  // ---------- malformed payloads per action-specific schema ----------

  it('returns null for a malformed closed payload (missing issue)', async () => {
    const payload = JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });

  it('returns null for a malformed opened payload (labels not an array)', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: { number: 1, title: 'Bad shape', labels: 'not-an-array' },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });

  it('returns null for a malformed labeled payload (missing label)', async () => {
    const payload = JSON.stringify({
      action: 'labeled',
      issue: { number: 1, title: 'Bad shape' },
      repository: { full_name: 'owner/repo' },
    });

    const event = await parser.parse(payload, issuesHeaders);

    expect(event).toBeNull();
  });
});
