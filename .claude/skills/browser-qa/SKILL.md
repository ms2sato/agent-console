---
name: browser-qa
description: Manual browser QA via Chrome DevTools MCP. Use when acceptance criteria include manual verification or UI changes need visual confirmation.
---

# Browser QA

Manual browser verification procedure for UI changes using Chrome DevTools MCP.

## When to Use

- Acceptance criteria include `manual verification`
- PR modifies `packages/client/src/components/`
- Visual or interaction behavior needs confirmation beyond automated tests

## Procedure

### 1. Start Dev Server

```bash
cd <repository-root>
bun run dev
```

**Check the startup log** for the actual port — Vite may auto-increment if the default port (5173) is in use:
```
Port 5173 is in use, trying another one...
  ➜  Local:   http://localhost:5174/
```

Also check `.env` for custom port configuration (`CLIENT_PORT`, `PORT`).

### 2. Navigate to the UI

```
mcp: navigate_page → http://localhost:<port>
mcp: take_screenshot → confirm page loaded
```

For specific pages, navigate directly via client route (SPA routing works):
```
mcp: navigate_page → http://localhost:<port>/sessions/<id>
```

### 3. Interact and Verify

Use Chrome DevTools MCP tools:

| Action | Tool | Tips |
|--------|------|------|
| Click element | `click` | Use `take_snapshot` first to get element UIDs |
| Type text | `type_text` | Click the input first to focus |
| Fill form field | `fill` | Target by UID from snapshot |
| Wait for async | `wait_for` | Wait for selector to appear |
| Check errors | `list_console_messages` | Look for JS errors |
| Screenshot | `take_screenshot` | Capture before/after states |

### 4. Verify Acceptance Criteria

For each `manual verification` criterion:
1. Reproduce the scenario described
2. Take a screenshot confirming the expected behavior
3. Check `list_console_messages` for unexpected errors

### 5. Cleanup

Stop the dev server when done (kill the background process or Ctrl+C).

## Screenshot Persistence & PR Upload

All screenshots should be saved to disk for later upload to the PR.

### Setup

Before starting QA, prepare the screenshot directory:
```bash
rm -rf .qa-screenshots && mkdir -p .qa-screenshots
```

### Taking Screenshots

Always use `filePath` to save to `.qa-screenshots/`:
```
take_screenshot with filePath: ".qa-screenshots/{descriptive-name}.png"
```

Use descriptive, hyphenated names:
- `restart-all-button.png`, `restart-result-toast.png`
- `error-{description}.png` (for error states)

### Selective Screenshot Policy

Only take screenshots for areas **relevant to the PR's change scope**:
- **Bug fix PRs**: Capture before/after states of the fixed behavior
- **UI change PRs**: Capture the changed areas
- **Always capture**: Error states encountered, regardless of relevance

### Uploading to PR

After QA, upload screenshots to the PR:
```bash
./scripts/upload-qa-screenshots.sh <PR_NUMBER>
```

This script:
1. Auto-detects the repository from `git remote` (override with `GITHUB_REPOSITORY` env var)
2. Creates a `qa-screenshots` GitHub Release if it doesn't exist (one-time, used as image hosting)
3. Uploads all `.png` files from `.qa-screenshots/` with unique names
4. Posts a PR comment with static thumbnails and expandable full-size images via `<details>`

**Note:** GitHub Release assets are served with `Content-Disposition: attachment`, so `<a href>` links trigger downloads instead of displaying images. The script uses `<details><summary>` to work around this.

If the PR number is not known, detect it:
```bash
gh pr view --json number -q '.number'
```

### Re-taking Screenshots

When re-taking screenshots (e.g., after implementation changes), **minimize the previous screenshot comment** on the PR before uploading new ones. This prevents reviewers from seeing outdated screenshots.

```bash
# 1. Find the previous screenshot comment's node ID
gh api graphql -f query='query { repository(owner: "OWNER", name: "REPO") { pullRequest(number: PR_NUM) { comments(first: 50) { nodes { id body createdAt } } } } }' \
  --jq '.data.repository.pullRequest.comments.nodes[] | select(.body | test("qa-screenshots")) | .id'

# 2. Minimize it as OUTDATED
gh api graphql -f query='mutation { minimizeComment(input: {subjectId: "NODE_ID", classifier: OUTDATED}) { minimizedComment { isMinimized } } }'

# 3. Upload new screenshots
./scripts/upload-qa-screenshots.sh <PR_NUMBER>
```

## Common Issues

- **Port conflict**: Check startup log for actual port. Vite auto-increments.
- **Blank page**: Run `bun run --filter '@agent-console/shared' build` first — client depends on shared types.
- **API errors**: Ensure backend is also running (dev script starts both, but check logs).
