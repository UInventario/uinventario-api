#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: $0 <dev|prod> <api-revision> <web-revision> [--rehearse]" >&2
  exit 2
}

[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || usage

environment="$1"
api_target="$2"
web_target="$3"
mode="${4:-rollback}"
region="${CLOUD_RUN_REGION:-us-central1}"

case "$environment" in
  dev) project_id="software-inventario-dev" ;;
  prod) project_id="software-inventario-prod" ;;
  *) usage ;;
esac

case "$mode" in
  rollback|--rehearse) ;;
  *) usage ;;
esac

revision_for_service() {
  service="$1"
  revision="$2"
  gcloud run revisions list \
    --service="$service" \
    --project="$project_id" \
    --region="$region" \
    --filter="metadata.name=$revision" \
    --format='value(metadata.name)'
}

current_traffic_target() {
  service="$1"
  latest="$(gcloud run services describe "$service" \
    --project="$project_id" \
    --region="$region" \
    --format='value(status.traffic[0].latestRevision)')"
  case "$latest" in
    true|True) printf 'LATEST\n'; return ;;
  esac
  gcloud run services describe "$service" \
    --project="$project_id" \
    --region="$region" \
    --format='value(status.traffic[0].revisionName)'
}

route_traffic() {
  service="$1"
  target="$2"
  if [ "$target" = "LATEST" ]; then
    gcloud run services update-traffic "$service" \
      --to-latest \
      --project="$project_id" \
      --region="$region" \
      --quiet >/dev/null
    return
  fi
  gcloud run services update-traffic "$service" \
    --to-revisions="$target=100" \
    --project="$project_id" \
    --region="$region" \
    --quiet >/dev/null
}

[ "$(revision_for_service uinventario-api "$api_target")" = "$api_target" ] || {
  echo "Revision $api_target does not belong to uinventario-api in $project_id." >&2
  exit 3
}
[ "$(revision_for_service uinventario-web "$web_target")" = "$web_target" ] || {
  echo "Revision $web_target does not belong to uinventario-web in $project_id." >&2
  exit 3
}

api_original="$(current_traffic_target uinventario-api)"
web_original="$(current_traffic_target uinventario-web)"
[ -n "$api_original" ] && [ -n "$web_original" ] || {
  echo "Both services must have one active revision before rollback." >&2
  exit 4
}

restore_required=false

restore_original() {
  echo "Restoring original traffic: API=$api_original Web=$web_original" >&2
  route_traffic uinventario-api "$api_original"
  route_traffic uinventario-web "$web_original"
}

cleanup() {
  exit_code="$?"
  if [ "$restore_required" = true ]; then
    restore_required=false
    restore_original || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

restore_required=true
gcloud run services update-traffic uinventario-api \
  --to-revisions="$api_target=100" \
  --project="$project_id" \
  --region="$region" \
  --quiet >/dev/null
gcloud run services update-traffic uinventario-web \
  --to-revisions="$web_target=100" \
  --project="$project_id" \
  --region="$region" \
  --quiet >/dev/null

sh "$(dirname "$0")/release-smoke.sh" "$environment"

if [ "$mode" = "--rehearse" ]; then
  restore_original
  restore_required=false
  sh "$(dirname "$0")/release-smoke.sh" "$environment"
  printf 'Rollback rehearsal passed; restored API=%s Web=%s\n' "$api_original" "$web_original"
else
  restore_required=false
  printf 'Rollback completed: API=%s Web=%s\n' "$api_target" "$web_target"
fi
