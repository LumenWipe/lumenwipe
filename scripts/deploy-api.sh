#!/usr/bin/env bash
# Deploys the API to Cloud Run without moving traffic until the new revision has proved itself.
#
#   deploy   capture the revision serving 100 percent, deploy the candidate with no traffic,
#            smoke test it on its tagged URL, promote it, verify it, and on a failure after
#            promotion roll back to the captured revision.
#   recover  run after a failed, timed out or cancelled deploy step: finish whatever an
#            interrupted deploy left undone. A deploy that ran to its end leaves nothing to do.
#
# Whenever traffic stays on or returns to the captured revision, the restore phase redeploys that
# revision's image by digest and moves traffic back to following the latest revision, so the kill
# switches in RELEASING.md keep taking effect. If the restore fails, the captured revision stays
# pinned at 100 percent and the run says so.
#
# Reads SERVICE, REGION, IMAGE, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, and optionally
# DRILL (none or fail-smoke) and API_SMOKE_KEY. Writes its progress to DEPLOY_STATE and a report
# to GITHUB_STEP_SUMMARY. SMOKE_TRIES, VERIFY_TRIES and RETRY_DELAY tune the retries, and DEEP_TRIES
# and DEEP_DELAY the candidate's /health/deep check.
set -euo pipefail

: "${SERVICE:?}" "${REGION:?}"
STATE="${DEPLOY_STATE:-${RUNNER_TEMP:?}/deploy-api.state}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
SMOKE_TRIES="${SMOKE_TRIES:-3}"
VERIFY_TRIES="${VERIFY_TRIES:-6}"
RETRY_DELAY="${RETRY_DELAY:-5}"
# /health/deep fails a network whose RPC probe takes over 3 s, so a short slowdown of a public RPC
# fails it too. Six tries 10 s apart (about 70 s) ride out a blip like the one in run 42546572053,
# which cleared within a minute; the API caches the check for 2 s, so every try probes afresh.
DEEP_TRIES="${DEEP_TRIES:-6}"
DEEP_DELAY="${DEEP_DELAY:-10}"
RESOURCE_FLAGS=(--min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi --execution-environment=gen1 --cpu-boost)

note() { printf '%s\n' "$*" >> "$SUMMARY"; }
error() { echo "::error::$*"; note "**Error:** $*"; }
warning() { echo "::warning::$*"; note "**Warning:** $*"; }

state_set() { printf '%s=%s\n' "$1" "$2" >> "$STATE"; }
state_get() { if [ -f "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -n 1; fi; }

describe() { gcloud run services describe "$SERVICE" --region "$REGION" --format=json; }

# The revision holding all traffic, or nothing when traffic is split or missing.
serving_revision() {
  jq -r '[.status.traffic[]? | select((.percent // 0) > 0)]
    | if length == 1 and .[0].percent == 100 then .[0].revisionName else empty end'
}

tag_url() { jq -r --arg tag "$1" '[.status.traffic[]? | select(.tag == $tag) | .url][0] // empty'; }

# get URL JQ_FILTER TRIES [VALUE] [HEADER_FILE]: succeeds once a 2xx body satisfies the filter,
# which reads VALUE as $v.
get() {
  local url="$1" filter="$2" tries="$3" value="${4:-}" header="${5:-}" body i
  for ((i = 1; i <= tries; i++)); do
    if [ -n "$header" ]; then
      body="$(curl -fsS --max-time 10 -H "@$header" "$url" 2> /dev/null)" || body=""
    else
      body="$(curl -fsS --max-time 10 "$url" 2> /dev/null)" || body=""
    fi
    if [ -n "$body" ] && jq -e --arg v "$value" "$filter" > /dev/null 2>&1 <<< "$body"; then
      printf '%s' "$body"
      return 0
    fi
    [ "$i" -lt "$tries" ] && sleep "$RETRY_DELAY"
  done
  return 1
}

check() {
  local name="$1"
  shift
  if get "$@" > /dev/null; then
    note "| $name | pass |"
  else
    note "| $name | **fail** |"
    return 1
  fi
}

# The body of a GET, then a line with its HTTP status (000 when nothing answered).
reply() { curl -sS --max-time 10 -w '\n%{http_code}' "$1" 2> /dev/null || true; }

# Reads a /health/deep body and prints the dependencies it reports down as a JSON array. Fails on
# anything but a health result whose dependency names are plain words, so each name is safe to
# print in the summary and in a workflow command.
deep_down() {
  jq -ce 'select((.status == "ok" or .status == "error") and (.details | type) == "object"
      and (.details | keys | all(test("^[a-z0-9_]+$"))))
    | [.details | to_entries[] | select(.value.status == "down") | .key]' 2> /dev/null
}

# /health/deep on the candidate. A dependency down there passes only when it is an RPC and the
# revision serving now, reached on the service URL, reports it down too: an upstream outage both
# share is not the candidate's fault. Anything that cannot be compared fails.
check_deep() {
  local url="$1" body down="" names i json prev svc_url serving only
  for ((i = 1; i <= DEEP_TRIES; i++)); do
    body="$(reply "$url/health/deep")"
    if [ "${body##*$'\n'}" = 200 ] && jq -e '.status == "ok"' > /dev/null 2>&1 <<< "${body%$'\n'*}"; then
      note "| /health/deep | pass |"
      return 0
    fi
    # The last attempt's view is the one compared, as it is the closest in time to the serving read.
    down="$(deep_down <<< "${body%$'\n'*}")" || down=""
    [ "$i" -lt "$DEEP_TRIES" ] && sleep "$DEEP_DELAY"
  done
  if [ -z "$down" ] || [ "$down" = "[]" ]; then
    note "| /health/deep | **fail** |"
    return 1
  fi
  names="$(jq -r 'join(", ")' <<< "$down")"
  if ! jq -e 'all(startswith("rpc_"))' > /dev/null <<< "$down"; then
    note "| /health/deep | **fail** (down: $names) |"
    return 1
  fi
  # Before promotion the service URL serves the captured revision at 100 percent; describe proves
  # it still does, since only a traffic tag would give that revision a URL of its own.
  prev="$(state_get prev)"
  if ! json="$(describe)" || [ "$(serving_revision <<< "$json")" != "$prev" ] ||
    ! svc_url="$(jq -er '.status.url // empty' <<< "$json")" ||
    ! serving="$(reply "$svc_url/health/deep" | sed '$d' | deep_down)"; then
    note "| /health/deep | **fail** (down: $names; $prev could not be read to compare) |"
    return 1
  fi
  only="$(jq -nc --argjson c "$down" --argjson s "$serving" '$c - $s')"
  if [ "$only" != "[]" ]; then
    note "| /health/deep | **fail** (down only on the candidate: $(jq -r 'join(", ")' <<< "$only")) |"
    return 1
  fi
  note "| /health/deep | upstream ($names) |"
  warning "/health/deep reports $names down on the candidate and on $prev, which serves now: an upstream outage, so the smoke test continues. Check /health/deep once it clears (docs/runbooks/bad-deploy.mdx)"
}

remove_tag() {
  run_traffic --remove-tags="$1" || warning "could not remove the $1 tag; remove it with: gcloud run services update-traffic $SERVICE --region $REGION --remove-tags=$1"
}

run_traffic() { gcloud run services update-traffic "$SERVICE" --region "$REGION" "$@" --quiet; }

smoke_candidate() {
  local url="$1" expected="$GITHUB_SHA" registry address header
  [ "${DRILL:-none}" = "fail-smoke" ] && expected="drill-forced-mismatch"
  note "| Check | Result |"
  note "| --- | --- |"
  check "/health" "$url/health" '.status == "ok"' "$SMOKE_TRIES" || return 1
  check "/ reports this commit" "$url/" ".gitSha == \$v" "$SMOKE_TRIES" "$expected" || return 1
  check_deep "$url" || return 1
  registry="$(get "$url/v1/config/exchange-registry" '(.entries | length) > 0' "$SMOKE_TRIES")" || {
    note "| /v1/config/exchange-registry | **fail** |"
    return 1
  }
  note "| /v1/config/exchange-registry | pass |"
  if [ -z "${API_SMOKE_KEY:-}" ]; then
    note "| analyze | skipped |"
    warning "analyze was not smoke tested: the API_SMOKE_KEY secret is not set"
    return 0
  fi
  address="$(jq -r '.entries[0].address' <<< "$registry")"
  header="$(mktemp)"
  printf 'Authorization: Bearer %s\n' "$API_SMOKE_KEY" > "$header"
  if check "analyze" "$url/v1/mainnet/account/$address" ".address == \$v" "$SMOKE_TRIES" "$address" "$header"; then
    rm -f "$header"
  else
    rm -f "$header"
    return 1
  fi
}

# Leaves the captured revision pinned at 100 percent after a failed restore, and says what that means.
pin_prev() {
  local prev
  prev="$(state_get prev)"
  state_set phase pinned
  run_traffic --to-revisions="$prev=100" || error "could not pin $prev; route traffic by hand: gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=$prev=100"
  error "the restore failed: traffic is pinned to $prev at 100 percent. Until a deploy succeeds, a kill switch must be set with --image=<serving image> and then gcloud run services update-traffic $SERVICE --region $REGION --to-latest (RELEASING.md)"
}

# Redeploys the captured revision's image so traffic follows the latest revision again.
restore() {
  local prev image restored json url
  prev="$(state_get prev)"
  image="$(state_get prev_image)"
  restored="$SERVICE-$(state_get suffix)-restore"
  state_set phase restoring
  note ""
  note "Restoring $prev's image as $restored."
  if ! gcloud run deploy "$SERVICE" --region "$REGION" --image "$image" --no-traffic --tag restore \
    --revision-suffix "$(state_get suffix)-restore" "${RESOURCE_FLAGS[@]}" --quiet; then
    pin_prev
    return 1
  fi
  json="$(describe)" || { pin_prev; return 1; }
  url="$(tag_url restore <<< "$json")"
  if [ -z "$url" ] || ! get "$url/health" '.status == "ok"' "$SMOKE_TRIES" > /dev/null; then
    remove_tag restore
    pin_prev
    return 1
  fi
  if [ "$(jq -r '.status.latestReadyRevisionName // empty' <<< "$json")" != "$restored" ]; then
    remove_tag restore
    pin_prev
    return 1
  fi
  if ! run_traffic --to-latest || ! json="$(describe)" || [ "$(serving_revision <<< "$json")" != "$restored" ]; then
    remove_tag restore
    pin_prev
    return 1
  fi
  state_set phase restored
  remove_tag restore
  note "Traffic follows the latest revision again: $restored serves $prev's image."
}

rollback() {
  local prev cand json i rolled=0
  prev="$(state_get prev)"
  cand="$(state_get cand)"
  state_set phase rolling-back
  error "$cand failed after promotion; rolling back to $prev"
  # A failed update-traffic may still have applied, so what describe reports decides.
  for ((i = 1; i <= 3; i++)); do
    run_traffic --to-revisions="$prev=100" || true
    if json="$(describe)" && [ "$(serving_revision <<< "$json")" = "$prev" ]; then
      rolled=1
      break
    fi
    [ "$i" -lt 3 ] && sleep "$RETRY_DELAY"
  done
  if [ "$rolled" = 1 ]; then
    state_set phase rolled-back
    note "Rolled back: $prev serves 100 percent."
    remove_tag candidate
    restore || true
  else
    state_set phase rollback-failed
    error "the rollback did not take: run gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=$prev=100"
  fi
}

# Traffic never left the captured revision; drop the candidate's tag and restore.
abandon() {
  local cand
  cand="$(state_get cand)"
  error "$1: $cand received no traffic and $(state_get prev) still serves"
  remove_tag candidate
  restore || true
  exit 1
}

deploy() {
  : "${IMAGE:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
  local json prev image suffix cand url
  : > "$STATE"
  note "## API deploy"
  note ""
  note "Commit: \`$GITHUB_SHA\`"
  [ "${DRILL:-none}" = "fail-smoke" ] && note "" && note "Drill: the smoke test is forced to fail."

  json="$(describe)"
  prev="$(serving_revision <<< "$json")"
  if [ -z "$prev" ]; then
    error "traffic is not on exactly one revision at 100 percent; nothing was deployed"
    exit 1
  fi
  image="$(gcloud run revisions describe "$prev" --region "$REGION" --format='value(status.imageDigest)')"
  if [ -z "$image" ]; then
    error "could not read the image digest of $prev; nothing was deployed"
    exit 1
  fi
  suffix="${GITHUB_SHA:0:7}-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  cand="$SERVICE-$suffix"
  state_set prev "$prev"
  state_set prev_image "$image"
  state_set suffix "$suffix"
  state_set cand "$cand"
  note "Serving before this run: \`$prev\`"
  note "Candidate: \`$cand\`"
  note ""

  state_set phase deployed
  gcloud run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" --no-traffic --tag candidate \
    --revision-suffix "$suffix" "${RESOURCE_FLAGS[@]}" --quiet || abandon "the candidate did not deploy"

  json="$(describe)" || abandon "could not read the service after the candidate deployed"
  url="$(tag_url candidate <<< "$json")"
  [ -n "$url" ] || abandon "the candidate has no tagged URL"
  smoke_candidate "$url" || abandon "the candidate failed its smoke test"

  json="$(describe)" || abandon "could not read the service before promotion"
  [ "$(jq -r '.status.latestReadyRevisionName // empty' <<< "$json")" = "$cand" ] ||
    abandon "a newer revision than the candidate appeared during the run"

  state_set phase promoted
  if ! run_traffic --to-latest; then
    rollback
    exit 1
  fi
  if ! json="$(describe)" || [ "$(serving_revision <<< "$json")" != "$cand" ] ||
    ! url="$(jq -r '.status.url // empty' <<< "$json")" ||
    ! get "$url/health" '.status == "ok"' "$VERIFY_TRIES" > /dev/null ||
    ! get "$url/" ".gitSha == \$v" "$VERIFY_TRIES" "$GITHUB_SHA" > /dev/null; then
    rollback
    exit 1
  fi
  state_set phase verified
  remove_tag candidate
  note ""
  note "Promoted: \`$cand\` serves 100 percent and follows the latest revision."
}

# An interrupted restore may already have moved traffic to the restore revision.
recover_restore() {
  local json
  if json="$(describe)" && [ "$(serving_revision <<< "$json")" = "$SERVICE-$(state_get suffix)-restore" ] &&
    jq -e '[.status.traffic[]? | select(.percent == 100)][0].latestRevision == true' > /dev/null <<< "$json"; then
    state_set phase restored
    remove_tag restore
    note "The interrupted restore had finished: traffic follows the latest revision."
  else
    remove_tag restore
    pin_prev
  fi
  exit 1
}

recover() {
  local phase
  phase="$(state_get phase)"
  case "$phase" in
    deployed) abandon "the deploy was interrupted before promotion" ;;
    promoted | rolling-back | rollback-failed)
      rollback
      exit 1
      ;;
    restoring) recover_restore ;;
    rolled-back)
      restore || true
      exit 1
      ;;
    *) echo "nothing to recover (phase: ${phase:-none})" ;;
  esac
}

case "${1:-}" in
  deploy) deploy ;;
  recover) recover ;;
  *)
    echo "usage: $0 deploy|recover" >&2
    exit 2
    ;;
esac
