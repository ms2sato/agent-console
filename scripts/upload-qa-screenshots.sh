#!/bin/bash
# upload-qa-screenshots.sh
#
# Uploads QA screenshots from a local directory to a GitHub Release
# and posts a PR comment with embedded images.
#
# Usage:
#   ./scripts/upload-qa-screenshots.sh <PR_NUMBER> [screenshot_dir]
#
# Arguments:
#   PR_NUMBER       - The PR number to comment on
#   screenshot_dir  - Directory containing PNG screenshots (default: .qa-screenshots)
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Screenshots saved as .png files with descriptive names
#     (e.g., "restart-all-button.png", "restart-result-toast.png")
#
# Repository detection:
#   Auto-detects owner/repo from git remote. Override with GITHUB_REPOSITORY env var.

set -euo pipefail

# Auto-detect repository from git remote (e.g., "ms2sato/agent-console")
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  REPO="$GITHUB_REPOSITORY"
else
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -z "$REMOTE_URL" ]; then
    echo "Error: Not in a git repository or no 'origin' remote configured" >&2
    exit 1
  fi
  # Extract owner/repo from SSH or HTTPS URL
  REPO=$(echo "$REMOTE_URL" | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')
fi

RELEASE_TAG="qa-screenshots"
PR_NUMBER="${1:-}"
SCREENSHOT_DIR="${2:-.qa-screenshots}"

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <PR_NUMBER> [screenshot_dir]" >&2
  exit 1
fi

if [ ! -d "$SCREENSHOT_DIR" ]; then
  echo "Error: Screenshot directory '$SCREENSHOT_DIR' not found" >&2
  exit 1
fi

# Count PNG files
FILE_COUNT=$(find "$SCREENSHOT_DIR" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "No PNG files found in '$SCREENSHOT_DIR'" >&2
  exit 1
fi

echo "Found $FILE_COUNT screenshot(s) in $SCREENSHOT_DIR (repo: $REPO)"

# Create release if it doesn't exist
if ! gh release view "$RELEASE_TAG" -R "$REPO" &>/dev/null; then
  echo "Creating release '$RELEASE_TAG'..."
  gh release create "$RELEASE_TAG" \
    --title "QA Screenshots (do not delete)" \
    --notes "Automated QA screenshot hosting for PR reviews. Do not delete this release." \
    -R "$REPO"
fi

# Upload each screenshot with a unique name and collect markdown
UPLOADED_IMAGES=()
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

for file in "$SCREENSHOT_DIR"/*.png; do
  [ -f "$file" ] || continue

  BASENAME=$(basename "$file" .png)
  UNIQUE_NAME="pr${PR_NUMBER}-${TIMESTAMP}-${BASENAME}.png"

  # Copy to temp with unique name for upload
  TMP_FILE="/tmp/${UNIQUE_NAME}"
  cp "$file" "$TMP_FILE"

  echo "Uploading ${BASENAME}.png as ${UNIQUE_NAME}..."
  gh release upload "$RELEASE_TAG" "$TMP_FILE" -R "$REPO" --clobber

  rm -f "$TMP_FILE"

  URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${UNIQUE_NAME}"
  # Convert filename to readable description (e.g., "restart-all-button" -> "restart all button")
  DESCRIPTION=$(echo "$BASENAME" | sed 's/[-_]/ /g')
  UPLOADED_IMAGES+=("### ${DESCRIPTION}"$'\n'"<a href=\"${URL}\"><img src=\"${URL}\" width=\"400\" alt=\"${DESCRIPTION}\"></a>")
done

# Build PR comment body
DISPLAY_TIME=$(date +"%Y-%m-%d %H:%M")
COMMENT_BODY="## QA Screenshots (${DISPLAY_TIME})"$'\n\n'
for img in "${UPLOADED_IMAGES[@]}"; do
  COMMENT_BODY+="${img}"$'\n\n'
done

echo "Posting comment to PR #${PR_NUMBER}..."
gh pr comment "$PR_NUMBER" -R "$REPO" --body "$COMMENT_BODY"

echo "Done! ${#UPLOADED_IMAGES[@]} screenshot(s) uploaded and posted to PR #${PR_NUMBER}"
