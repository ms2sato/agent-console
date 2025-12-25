#!/usr/bin/env bash
# Queue management helper for parallel review system

QUEUE_DIR=".claude/review-queue"
SINGLE_FILE="$QUEUE_DIR/single-file.jsonl"
CROSS_FILE="$QUEUE_DIR/cross-file.jsonl"
FIXING="$QUEUE_DIR/fixing.json"

# Initialize queue files
init() {
  mkdir -p "$QUEUE_DIR"
  touch "$SINGLE_FILE" "$CROSS_FILE"
  echo '{}' > "$FIXING"
  echo "Queue initialized"
}

# Add issue to queue
# Usage: add_issue <type> <severity> <reviewer> <file> <line> <description>
add_issue() {
  local type="$1"  # single-file or cross-file
  local severity="$2"
  local reviewer="$3"
  local file="$4"
  local line="$5"
  local description="$6"

  local id="issue-$(date +%s)-$$-$RANDOM"
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  local issue=$(cat <<EOF
{"id":"$id","severity":"$severity","reviewer":"$reviewer","file":"$file","line":$line,"description":"$description","status":"pending","timestamp":"$timestamp"}
EOF
)

  if [ "$type" = "single-file" ]; then
    echo "$issue" >> "$SINGLE_FILE"
  else
    echo "$issue" >> "$CROSS_FILE"
  fi

  echo "$id"
}

# Get next pending issue
get_next_pending() {
  grep '"status":"pending"' "$SINGLE_FILE" | head -n 1
}

# Check if file is locked
is_locked() {
  local file="$1"
  jq -e ".[\"$file\"]" "$FIXING" > /dev/null 2>&1
}

# Acquire lock
lock_file() {
  local file="$1"
  local worker="$2"
  local issue_id="$3"
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  if is_locked "$file"; then
    echo "File already locked: $file" >&2
    return 1
  fi

  local lock=$(cat <<EOF
{"worker":"$worker","issueId":"$issue_id","timestamp":"$timestamp"}
EOF
)

  jq ".[\"$file\"] = $lock" "$FIXING" > "$FIXING.tmp" && mv "$FIXING.tmp" "$FIXING"
}

# Release lock
unlock_file() {
  local file="$1"
  jq "del(.[\"$file\"])" "$FIXING" > "$FIXING.tmp" && mv "$FIXING.tmp" "$FIXING"
}

# Update issue status
update_status() {
  local issue_id="$1"
  local new_status="$2"

  # Update in single-file queue
  if grep -q "\"id\":\"$issue_id\"" "$SINGLE_FILE" 2>/dev/null; then
    local tmp=$(mktemp)
    while IFS= read -r line; do
      if echo "$line" | grep -q "\"id\":\"$issue_id\""; then
        echo "$line" | jq ".status = \"$new_status\""
      else
        echo "$line"
      fi
    done < "$SINGLE_FILE" > "$tmp"
    mv "$tmp" "$SINGLE_FILE"
  fi

  # Update in cross-file queue
  if grep -q "\"id\":\"$issue_id\"" "$CROSS_FILE" 2>/dev/null; then
    local tmp=$(mktemp)
    while IFS= read -r line; do
      if echo "$line" | grep -q "\"id\":\"$issue_id\""; then
        echo "$line" | jq ".status = \"$new_status\""
      else
        echo "$line"
      fi
    done < "$CROSS_FILE" > "$tmp"
    mv "$tmp" "$CROSS_FILE"
  fi
}

# Count issues by status and severity
count_issues() {
  local file="${1:-$SINGLE_FILE}"

  echo "=== Issue counts ==="
  echo -n "CRITICAL pending: "
  grep '"severity":"CRITICAL"' "$file" 2>/dev/null | grep '"status":"pending"' | wc -l | tr -d ' '
  echo -n "HIGH pending: "
  grep '"severity":"HIGH"' "$file" 2>/dev/null | grep '"status":"pending"' | wc -l | tr -d ' '
  echo -n "Total pending: "
  grep '"status":"pending"' "$file" 2>/dev/null | wc -l | tr -d ' '
  echo -n "Total fixed: "
  grep '"status":"fixed"' "$file" 2>/dev/null | wc -l | tr -d ' '
}

# Clean queue (reset)
clean() {
  rm -f "$SINGLE_FILE" "$CROSS_FILE" "$FIXING"
  init
}

# Main command dispatcher
case "${1:-}" in
  init) init ;;
  add) shift; add_issue "$@" ;;
  next) get_next_pending ;;
  lock) lock_file "$2" "$3" "$4" ;;
  unlock) unlock_file "$2" ;;
  update) update_status "$2" "$3" ;;
  count) count_issues "$2" ;;
  clean) clean ;;
  *)
    echo "Usage: $0 {init|add|next|lock|unlock|update|count|clean}"
    exit 1
    ;;
esac
