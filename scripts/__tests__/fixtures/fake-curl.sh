#!/usr/bin/env bash
#
# Test fixture for scripts/__tests__/setup-multiuser-checks.test.mjs (Issue
# #1717): stands in for the `<curl-cmd>` argument of the post-deploy
# verification check V5 (health) in scripts/lib/setup-multiuser-checks.sh.
# Emulates exactly the invocation shape the check uses --
# `curl -s -m 5 -o <body-file> -w '%{http_code}' <url>` -- by writing the
# canned body to the `-o` file and printing the canned status code on
# stdout. Canned answers via environment variables:
#
#   FAKE_CURL_STATUS  the HTTP code to print (default 200); `000` also exits
#                     7 the way real curl does on a refused connection
#   FAKE_CURL_BODY    the response body written to the `-o` file
#   FAKE_CURL_STATUS_SEQ  comma-separated codes, one per invocation (the last
#                     repeats), e.g. `503,503,200`; needs FAKE_COUNTER_DIR (a
#                     directory the test owns) and overrides FAKE_CURL_STATUS
#   FAKE_ARGV_LOG     when set, this fixture's own argv is appended to that
#                     file (one line per invocation), so a test can count
#                     attempts and pin the URL
set -eu
if [ -n "${FAKE_ARGV_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$FAKE_ARGV_LOG"
fi
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  printf '%s' "${FAKE_CURL_BODY:-}" >"$out"
fi
status="${FAKE_CURL_STATUS:-200}"
if [ -n "${FAKE_CURL_STATUS_SEQ:-}" ]; then
  # Per-call answers: the Nth invocation prints the Nth comma-separated code
  # (the last one repeats). The call count lives in $FAKE_COUNTER_DIR/curl.
  n=$(( $(cat "$FAKE_COUNTER_DIR/curl" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$FAKE_COUNTER_DIR/curl"
  IFS=, read -r -a seq <<<"$FAKE_CURL_STATUS_SEQ"
  idx=$((n - 1))
  [ "$idx" -ge "${#seq[@]}" ] && idx=$((${#seq[@]} - 1))
  status="${seq[$idx]}"
fi
printf '%s' "$status"
if [ "$status" = "000" ]; then
  exit 7
fi
