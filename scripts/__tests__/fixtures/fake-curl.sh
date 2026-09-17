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
printf '%s' "$status"
if [ "$status" = "000" ]; then
  exit 7
fi
