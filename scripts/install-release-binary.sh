#!/usr/bin/env bash
# Installs one pinned binary from a release archive into the current directory. When the archive is
# already at <archive> (restored from the CI cache) it is used as is; otherwise it is downloaded with
# scripts/download.sh. Either way the archive must match <sha256> before anything is extracted, so a
# cached archive is held to the same pin as a downloaded one. A cached archive that does not match
# fails the run instead of being replaced by a download: it can only get there by tampering.
# Usage: scripts/install-release-binary.sh <archive> <url> <sha256> <member> [strip-components]
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "usage: scripts/install-release-binary.sh <archive> <url> <sha256> <member> [strip-components]" >&2
  exit 2
fi

archive="$1"
url="$2"
sha256="$3"
member="$4"
strip="${5:-0}"

if ! [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "sha256 must be 64 lowercase hex characters, got '$sha256'" >&2
  exit 2
fi
if ! [[ "$strip" =~ ^[0-9]$ ]]; then
  echo "strip-components must be a single digit, got '$strip'" >&2
  exit 2
fi
if [ -z "$member" ] || [[ "$member" == /* ]] || [[ "/$member/" == */../* ]]; then
  echo "member must be a relative path inside the archive, got '$member'" >&2
  exit 2
fi
if [ -z "$archive" ] || [ -z "$url" ]; then
  echo "archive and url must not be empty" >&2
  exit 2
fi

if [ -e "$archive" ]; then
  cached=true
  echo "Using the cached $(basename "$archive"), checking it against the pinned SHA-256."
else
  cached=false
  mkdir -p "$(dirname "$archive")"
  "$(dirname "$0")/download.sh" "$url" "$archive"
fi

if ! echo "$sha256  $archive" | sha256sum -c -; then
  if [ "$cached" = true ]; then
    echo "::error::The cached $(basename "$archive") does not match the pinned SHA-256. Refusing to use it and not downloading over it: a cache entry is only saved after this check passes, so a mismatch means the entry was tampered with." >&2
  fi
  exit 1
fi

tar -xzf "$archive" --strip-components="$strip" "$member"
