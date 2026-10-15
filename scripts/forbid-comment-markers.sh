#!/usr/bin/env bash
# Usage:
#   forbid-comment-markers.sh            scan every tracked file
#   forbid-comment-markers.sh --staged   scan lines added by the staged diff
#
# Exit 1 on a match, 2 on a tool failure. The bracketed character keeps the
# pattern from matching its own spelling in this file.
set -euo pipefail

PATTERN='commentlin[t]'

report_tool_failure() {
  echo "forbid-comment-markers: $1 failed with exit $2" >&2
  exit 2
}

if [ "${1:-}" = "--staged" ]; then
  # `>` distinguishes added content from diff headers and added lines
  # beginning with `+`. `--no-prefix` keeps header paths directly usable;
  # `@@` supplies added-line numbers.
  diff=$(git diff --cached -U0 --no-color --no-prefix --output-indicator-new='>')
  status=0
  matches=$(printf '%s\n' "$diff" | awk -v pattern="$PATTERN" '
    /^\+\+\+ / { file = substr($0, 5) }
    /^@@ / { match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) + 0 }
    /^>/ { if (tolower($0) ~ pattern) print file ":" line ": " substr($0, 2); line++ }
  ') || status=$?
  if [ "$status" -ne 0 ]; then
    report_tool_failure "awk" "$status"
  fi
  if [ -n "$matches" ]; then
    echo "forbidden comment marker in staged changes:" >&2
    echo "$matches" >&2
    echo "Remove the marker and stage the file again." >&2
    exit 1
  fi
  exit 0
fi

status=0
git grep -n -I -i -E -e "$PATTERN" -- . || status=$?
if [ "$status" -eq 0 ]; then
  echo "forbidden comment marker found in tracked files" >&2
  exit 1
fi
if [ "$status" -ne 1 ]; then
  report_tool_failure "git grep" "$status"
fi
