#!/usr/bin/env bash
# Downloads a URL to a file, retrying any error (an HTTP 5xx, a dropped connection) with backoff.
# No retry starts after 120 s and each attempt is capped at 60 s. The file appears under its final
# name only after a complete download, so a failed run leaves nothing behind. Verify the checksum
# separately. DOWNLOAD_RETRY_MAX_TIME (1 to 120 s) shortens the retry window for tests.
# Usage: scripts/download.sh <url> <output>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/download.sh <url> <output>" >&2
  exit 2
fi

url="$1"
out="$2"
retry_max_time="${DOWNLOAD_RETRY_MAX_TIME:-120}"

if ! [[ "$retry_max_time" =~ ^[1-9][0-9]*$ ]] || [ "$retry_max_time" -gt 120 ]; then
  echo "DOWNLOAD_RETRY_MAX_TIME must be a whole number from 1 to 120, got '$retry_max_time'" >&2
  exit 2
fi

tmp="$(mktemp "$out.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

curl -sSfL --connect-timeout 15 --max-time 60 \
  --retry 5 --retry-all-errors --retry-max-time "$retry_max_time" \
  -o "$tmp" "$url"
mv "$tmp" "$out"
