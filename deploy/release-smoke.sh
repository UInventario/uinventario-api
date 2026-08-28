#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: $0 <dev|prod>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage

environment="$1"
region="${CLOUD_RUN_REGION:-us-central1}"

case "$environment" in
  dev) project_id="software-inventario-dev" ;;
  prod) project_id="software-inventario-prod" ;;
  *) usage ;;
esac

api_url="$(gcloud run services describe uinventario-api \
  --project="$project_id" \
  --region="$region" \
  --format='value(status.url)')"
web_url="$(gcloud run services describe uinventario-web \
  --project="$project_id" \
  --region="$region" \
  --format='value(status.url)')"

[ -n "$api_url" ] || { echo "API URL is unavailable in $project_id." >&2; exit 3; }
[ -n "$web_url" ] || { echo "Web URL is unavailable in $project_id." >&2; exit 3; }

curl --fail --silent --show-error "$api_url/health/live" >/dev/null
curl --fail --silent --show-error "$api_url/health/ready" >/dev/null
curl --fail --silent --show-error "$web_url/health/live" >/dev/null
proxy_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$web_url/api/v1/auth/sessions/current")"
[ "$proxy_status" = "401" ] || {
  echo "Web-to-API proxy returned HTTP $proxy_status; expected unauthenticated 401." >&2
  exit 5
}
config="$(curl --fail --silent --show-error "$web_url/config.json")"
printf '%s' "$config" | grep -Eq '"environment"[[:space:]]*:[[:space:]]*"'"$environment"'"'
printf '%s' "$config" | grep -Eq '"apiBaseUrl"[[:space:]]*:[[:space:]]*"/api/v1"'
curl --fail --silent --show-error "$web_url/" >/dev/null

printf 'Release smoke passed for %s: API=%s Web=%s\n' "$environment" "$api_url" "$web_url"
