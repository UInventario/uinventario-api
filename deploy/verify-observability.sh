#!/usr/bin/env sh
set -eu

[ "$#" -eq 1 ] || { echo "Usage: $0 <dev|prod>" >&2; exit 2; }
environment="$1"
region="${CLOUD_RUN_REGION:-us-central1}"
case "$environment" in
  dev) project_id="software-inventario-dev" ;;
  prod) project_id="software-inventario-prod" ;;
  *) echo "Environment must be dev or prod." >&2; exit 2 ;;
esac

api_url="$(gcloud run services describe uinventario-api --project="$project_id" --region="$region" --format='value(status.url)')"
web_url="$(gcloud run services describe uinventario-web --project="$project_id" --region="$region" --format='value(status.url)')"
curl --fail --silent --show-error "$api_url/health/live" >/dev/null
curl --fail --silent --show-error "$api_url/health/ready" | grep -q '"database"'
curl --fail --silent --show-error "$web_url/health/live" >/dev/null

for metric in uinventario_application_errors uinventario_critical_queue_errors; do
  gcloud logging metrics describe "$metric" --project="$project_id" >/dev/null
done

policy_count="$(gcloud monitoring policies list --project="$project_id" \
  --filter="userLabels.app=uinventario AND userLabels.environment=$environment" \
  --format='value(name)' | wc -l | tr -d ' ')"
[ "$policy_count" -ge 5 ] || {
  echo "Expected at least 5 UInventario alert policies; found $policy_count." >&2
  exit 1
}

printf 'Observability verified for %s: %s policies, health dependencies safe.\n' \
  "$environment" "$policy_count"
