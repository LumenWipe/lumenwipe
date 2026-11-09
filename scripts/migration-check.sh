#!/usr/bin/env bash
# Read-only check of the API's infrastructure, run after any project or organization move, IAM or
# policy change: prints PASS, FAIL or SKIPPED per check and exits 1 when any check fails. It only
# describes, lists and reads (gcloud describe/list/get-iam-policy, gh run list, curl GET); it
# never creates or changes anything.
#
# Required: GCP_PROJECT_ID, GCP_REGION, SERVICE. Optional, each check that needs one is SKIPPED
# without it:
#   API_DOMAIN            custom domain of the API, without scheme
#   GITHUB_REPOSITORY     owner/name of this repository, for the deploy run and its trust condition
#   WIF_PROVIDER          full resource name of the workload identity provider the deploy uses
#   CHECK_API_KEY         a testnet self-serve test key, never an integrator's key
#   ALERT_CHANNEL         notification channel resource name every alert policy must route to
# Expectations, with their defaults:
#   EXPECTED_INGRESS (all), EXPECTED_INVOKER (allUsers), EXPECTED_SA_ROLES (roles/datastore.user,
#   space separated, the exact project roles of the runtime service account),
#   MIN_LOG_RETENTION_DAYS (30)
# Behaviour:
#   SKIP_DENIED=1         report a check the current identity is not allowed to read as SKIPPED
#                         instead of FAIL (the manual workflow sets it)
#   DRILL=fail-check      expects a wrong invoker member, so ingress-invoker fails and the run
#                         exits 1, proving the gate fails
#   GITHUB_STEP_SUMMARY   also writes the results there as a table
#
# To add a check: write a check_<name> function that sets `detail` and returns 0 (pass), 1 (fail)
# or 2 (skipped), read infrastructure only through gc, gh_read and the curl helpers below, add
# <name> to CHECKS, extend the stubs in scripts/migration-check.test.ts so the new reads are
# allowed, and list the check in docs/runbooks/restore-api-keys.mdx.
set -uo pipefail

: "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}" "${SERVICE:?}"
EXPECTED_INGRESS="${EXPECTED_INGRESS:-all}"
EXPECTED_INVOKER="${EXPECTED_INVOKER:-allUsers}"
EXPECTED_SA_ROLES="${EXPECTED_SA_ROLES:-roles/datastore.user}"
MIN_LOG_RETENTION_DAYS="${MIN_LOG_RETENTION_DAYS:-30}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
[ "${DRILL:-none}" = "fail-check" ] && EXPECTED_INVOKER="user:drill-forced-mismatch@example.invalid"

CHECKS=(health ingress-invoker deploy-pipeline revision service-account test-key domain billing logging alerting org-policies)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
detail=""
service_json=""

# gcloud, read verbs only. A refusal for lack of permission leaves a marker the runner reads.
gc() {
  if gcloud "$@" --project="$GCP_PROJECT_ID" --format=json 2> "$work/stderr"; then return 0; fi
  if grep -qiE 'PERMISSION_DENIED|does not have .*permission|forbidden|403' "$work/stderr"; then
    touch "$work/denied"
  fi
  return 1
}

gh_read() { gh "$@" 2> /dev/null; }

get_body() { curl -fsS --max-time 15 "$1" 2> /dev/null; }

# Called directly, never in $(...), so the description is fetched once per run.
load_service() {
  [ -n "$service_json" ] && return 0
  service_json="$(gc run services describe "$SERVICE" --region="$GCP_REGION")" || {
    detail="cannot read the service"
    return 1
  }
}

svc() { jq -r "$1" <<< "$service_json"; }

health_ok() { jq -e '.status == "ok"' > /dev/null 2>&1 <<< "$(get_body "$1")"; }

check_health() {
  local platform base bad=()
  load_service || return 1
  platform="$(svc '.status.url // empty')"
  [ -n "$platform" ] || { detail="the service has no URL"; return 1; }
  health_ok "$platform/health" || bad+=("$platform/health")
  base="$platform"
  if [ -n "${API_DOMAIN:-}" ]; then
    base="https://$API_DOMAIN"
    health_ok "$base/health" || bad+=("$base/health")
  fi
  health_ok "$base/health/deep" || bad+=("$base/health/deep")
  if [ "${#bad[@]}" -gt 0 ]; then
    detail="not ok: ${bad[*]}"
    return 1
  fi
  detail="ok: $platform/health${API_DOMAIN:+, $base/health}, $base/health/deep"
}

check_ingress_invoker() {
  local ingress policy
  load_service || return 1
  ingress="$(svc '.metadata.annotations["run.googleapis.com/ingress"] // empty')"
  policy="$(gc run services get-iam-policy "$SERVICE" --region="$GCP_REGION")" || { detail="cannot read the IAM policy"; return 1; }
  if [ "$ingress" != "$EXPECTED_INGRESS" ]; then
    detail="ingress is '${ingress:-unset}', expected '$EXPECTED_INGRESS'"
    return 1
  fi
  if ! jq -e --arg m "$EXPECTED_INVOKER" \
    'any(.bindings[]?; .role == "roles/run.invoker" and any(.members[]?; . == $m))' > /dev/null <<< "$policy"; then
    detail="roles/run.invoker is not bound to $EXPECTED_INVOKER"
    return 1
  fi
  detail="ingress $ingress, roles/run.invoker bound to $EXPECTED_INVOKER"
}

check_deploy_pipeline() {
  local run conclusion provider
  if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${WIF_PROVIDER:-}" ]; then
    detail="GITHUB_REPOSITORY or WIF_PROVIDER is not set"
    return 2
  fi
  run="$(gh_read run list --repo "$GITHUB_REPOSITORY" --workflow deploy-api.yml --branch main \
    --event workflow_dispatch --limit 1 --json conclusion,url)" || { detail="cannot list deploy runs"; return 1; }
  conclusion="$(jq -r '.[0].conclusion // "none"' <<< "$run")"
  if [ "$conclusion" != "success" ]; then
    detail="the latest manual deploy run concluded '$conclusion'; run the deploy workflow by hand first"
    return 1
  fi
  provider="$(gc iam workload-identity-pools providers describe "$WIF_PROVIDER")" || { detail="cannot read the workload identity provider"; return 1; }
  if ! jq -e --arg single "'$GITHUB_REPOSITORY'" --arg double "\"$GITHUB_REPOSITORY\"" \
    '(.attributeCondition // "") | contains($single) or contains($double)' > /dev/null <<< "$provider"; then
    detail="the provider's attribute condition does not name $GITHUB_REPOSITORY"
    return 1
  fi
  detail="manual deploy $(jq -r '.[0].url' <<< "$run") succeeded; trust condition names $GITHUB_REPOSITORY"
}

check_revision() {
  local created ready
  load_service || return 1
  created="$(svc '.status.latestCreatedRevisionName // empty')"
  ready="$(svc '.status.latestReadyRevisionName // empty')"
  if [ -z "$created" ] || [ "$created" != "$ready" ]; then
    detail="latest revision '${created:-none}' is not ready (ready: '${ready:-none}')"
    return 1
  fi
  if ! jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' > /dev/null <<< "$service_json"; then
    detail="the service is not Ready"
    return 1
  fi
  detail="$ready booted and is ready"
}

check_service_account() {
  local sa policy roles expected
  load_service || return 1
  sa="$(svc '.spec.template.spec.serviceAccountName // empty')"
  [ -n "$sa" ] || { detail="the service runs as the default compute account"; return 1; }
  policy="$(gc projects get-iam-policy "$GCP_PROJECT_ID")" || { detail="cannot read the project IAM policy"; return 1; }
  roles="$(jq -r --arg m "serviceAccount:$sa" '[.bindings[]? | select(any(.members[]?; . == $m)) | .role] | sort | join(" ")' <<< "$policy")"
  expected="$(tr ' ' '\n' <<< "$EXPECTED_SA_ROLES" | sed '/^$/d' | sort | paste -sd ' ' -)"
  if [ "$roles" != "$expected" ]; then
    detail="$sa holds '${roles:-no roles}', expected '$expected'"
    return 1
  fi
  detail="$sa holds only $roles"
}

check_test_key() {
  local base code header
  [ -n "${CHECK_API_KEY:-}" ] || { detail="CHECK_API_KEY is not set"; return 2; }
  if [ -n "${API_DOMAIN:-}" ]; then
    base="https://$API_DOMAIN"
  else
    load_service || return 1
    base="$(svc '.status.url // empty')"
  fi
  header="$work/auth"
  printf 'Authorization: Bearer %s\n' "$CHECK_API_KEY" > "$header"
  # Without a source the route answers 400 invalid_source, but only once the key has resolved.
  code="$(curl -sS --max-time 15 -o "$work/body" -w '%{http_code}' -H "@$header" "$base/v1/testnet/close/status" 2> /dev/null)"
  rm -f "$header"
  if [ "$code" != "400" ] || ! jq -e '.error.code == "invalid_source"' > /dev/null 2>&1 < "$work/body"; then
    detail="the test key did not resolve (HTTP ${code:-none})"
    return 1
  fi
  detail="the test key resolved"
}

check_domain() {
  local mapping expiry
  [ -n "${API_DOMAIN:-}" ] || { detail="API_DOMAIN is not set"; return 2; }
  mapping="$(gc run domain-mappings describe --domain="$API_DOMAIN" --region="$GCP_REGION")" || { detail="cannot read the domain mapping"; return 1; }
  if ! jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' > /dev/null <<< "$mapping"; then
    detail="the mapping for $API_DOMAIN is not Ready"
    return 1
  fi
  expiry="$(curl -sv --max-time 15 -o /dev/null "https://$API_DOMAIN/health" 2>&1 | sed -n 's/^\*[[:space:]]*expire date:[[:space:]]*//p' | head -n 1)"
  detail="$API_DOMAIN mapping Ready, certificate expires ${expiry:-at an unread date}"
}

check_billing() {
  local billing account budgets
  billing="$(gc billing projects describe "$GCP_PROJECT_ID")" || { detail="cannot read the billing link"; return 1; }
  if ! jq -e '.billingEnabled == true' > /dev/null <<< "$billing"; then
    detail="billing is not enabled"
    return 1
  fi
  account="$(jq -r '.billingAccountName // "" | sub("^billingAccounts/"; "")' <<< "$billing")"
  budgets="$(gc billing budgets list --billing-account="$account")" || { detail="cannot list budgets"; return 1; }
  if ! jq -e 'any(.[]; (.thresholdRules // []) | length > 0)' > /dev/null <<< "$budgets"; then
    detail="no budget with an alert threshold on the billing account"
    return 1
  fi
  detail="billing enabled, $(jq 'length' <<< "$budgets") budget(s) with alert thresholds"
}

check_logging() {
  local buckets sinks retention
  buckets="$(gc logging buckets list)" || { detail="cannot list log buckets"; return 1; }
  sinks="$(gc logging sinks list)" || { detail="cannot list log sinks"; return 1; }
  retention="$(jq -r '[.[] | select(.name | endswith("/buckets/_Default")) | .retentionDays // 30][0] // empty' <<< "$buckets")"
  if [ -z "$retention" ] || [ "$retention" -lt "$MIN_LOG_RETENTION_DAYS" ]; then
    detail="_Default bucket retention is ${retention:-missing}, expected at least $MIN_LOG_RETENTION_DAYS days"
    return 1
  fi
  if ! jq -e '[.[] | select(.disabled != true) | .name] | index("_Required") != null and index("_Default") != null' > /dev/null <<< "$sinks"; then
    detail="the _Required or _Default sink is missing or disabled"
    return 1
  fi
  detail="_Default retention ${retention}d; sinks: $(jq -r '[.[].name] | join(", ")' <<< "$sinks")"
}

check_alerting() {
  local policies uptime
  policies="$(gc beta monitoring policies list)" || { detail="cannot list alert policies"; return 1; }
  uptime="$(gc monitoring uptime list-configs)" || { detail="cannot list uptime checks"; return 1; }
  if ! jq -e 'length > 0 and all(.[]; .enabled == true)' > /dev/null <<< "$policies"; then
    detail="no alert policy, or one is disabled"
    return 1
  fi
  if ! jq -e --arg c "${ALERT_CHANNEL:-}" \
    'all(.[]; (.notificationChannels // []) as $n | if $c == "" then ($n | length > 0) else ($n | index($c) != null) end)' > /dev/null <<< "$policies"; then
    detail="an alert policy is not routed to ${ALERT_CHANNEL:-any channel}"
    return 1
  fi
  if ! jq -e 'length > 0' > /dev/null <<< "$uptime"; then
    detail="no uptime check"
    return 1
  fi
  detail="$(jq 'length' <<< "$policies") alert policies enabled and routed, $(jq 'length' <<< "$uptime") uptime check(s)"
}

check_org_policies() {
  local list
  list="$(gc org-policies list)" || { detail="cannot list organization policy constraints"; return 1; }
  detail="in force: $(jq -r '[.[].constraint // .name | sub("^constraints/"; "")] | if length == 0 then "none" else join(", ") end' <<< "$list")"
}

passed=0
failed=0
skipped=0
{
  echo "## Migration check"
  echo ""
  [ "${DRILL:-none}" = "fail-check" ] && echo "Drill: ingress-invoker expects a wrong member and must fail." && echo ""
  echo "| Check | Result | Detail |"
  echo "| --- | --- | --- |"
} >> "$SUMMARY"
for name in "${CHECKS[@]}"; do
  detail=""
  rm -f "$work/denied"
  "check_${name//-/_}"
  rc=$?
  case "$rc" in
    0) result=PASS passed=$((passed + 1)) ;;
    2) result=SKIPPED skipped=$((skipped + 1)) ;;
    *)
      if [ "${SKIP_DENIED:-0}" = "1" ] && [ -e "$work/denied" ]; then
        result=SKIPPED skipped=$((skipped + 1))
        detail="this identity is not allowed to read it"
      else
        result=FAIL failed=$((failed + 1))
      fi
      ;;
  esac
  printf '%-8s %-16s %s\n' "$result" "$name" "$detail"
  printf '| %s | %s | %s |\n' "$name" "$result" "$detail" >> "$SUMMARY"
done
echo "$passed passed, $failed failed, $skipped skipped"
[ "$failed" -eq 0 ]
