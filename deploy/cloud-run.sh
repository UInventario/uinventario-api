#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: $0 <dev|prod> <container-image> <https-web-origin>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage

environment="$1"
image="$2"
web_origin="${3%/}"
region="${CLOUD_RUN_REGION:-us-central1}"

case "$environment" in
  dev)
    project_id="software-inventario-dev"
    database_secret="uinventario-dev-database-url"
    ;;
  prod)
    project_id="software-inventario-prod"
    database_secret="uinventario-prod-database-url"
    ;;
  *) usage ;;
esac

case "$web_origin" in
  https://*) ;;
  *) echo "Web origin must be an HTTPS origin." >&2; exit 2 ;;
esac

case "${web_origin#https://}" in
  ''|*/*|*\?*|*\#*|*@*) echo "Web origin must not contain a path, credentials, query or fragment." >&2; exit 2 ;;
esac

case "$image" in
  *.pkg.dev/"$project_id"/*:*) ;;
  *) echo "Container image must be a tagged Artifact Registry image in $project_id." >&2; exit 2 ;;
esac

service_name="uinventario-api"
migration_job="uinventario-api-migrate"
runtime_service_account="${API_RUNTIME_SERVICE_ACCOUNT:-uinventario-api-runtime@${project_id}.iam.gserviceaccount.com}"

database_secret_state="$(gcloud secrets versions describe latest \
  --secret="$database_secret" \
  --project="$project_id" \
  --format='value(state)' 2>/dev/null || true)"
if [ "$database_secret_state" != "ENABLED" ]; then
  echo "Database secret $database_secret has no enabled latest version in $project_id. Resolve Jira UIN-27 first." >&2
  exit 3
fi

if ! gcloud artifacts docker images describe "$image" --project="$project_id" >/dev/null 2>&1; then
  echo "Container image $image is unavailable in $project_id." >&2
  exit 4
fi

gcloud run jobs deploy "$migration_job" \
  --project="$project_id" \
  --region="$region" \
  --image="$image" \
  --service-account="$runtime_service_account" \
  --command=node \
  --args=./node_modules/typeorm/cli.js,-d,dist/database/data-source.js,migration:run \
  --set-secrets="DATABASE_URL=${database_secret}:latest" \
  --tasks=1 \
  --parallelism=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --cpu=1 \
  --memory=512Mi \
  --labels="app=uinventario,environment=${environment},component=migrations" \
  --quiet

gcloud run jobs execute "$migration_job" \
  --project="$project_id" \
  --region="$region" \
  --wait \
  --quiet

gcloud run deploy "$service_name" \
  --project="$project_id" \
  --region="$region" \
  --image="$image" \
  --service-account="$runtime_service_account" \
  --set-secrets="DATABASE_URL=${database_secret}:latest" \
  --set-env-vars="NODE_ENV=production,DEPLOY_ENV=${environment},DB_MIGRATIONS_RUN=false,CORS_ORIGINS=${web_origin},PASSWORD_RESET_PUBLIC_URL=${web_origin}/restablecer,PASSWORD_RESET_DELIVERY=disabled" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --cpu-throttling \
  --concurrency=40 \
  --min=0 \
  --max=3 \
  --timeout=60s \
  --labels="app=uinventario,environment=${environment},component=api" \
  --startup-probe=httpGet.path=/health/live,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=3,failureThreshold=10 \
  --liveness-probe=httpGet.path=/health/live,initialDelaySeconds=10,timeoutSeconds=3,periodSeconds=30,failureThreshold=3 \
  --readiness-probe=httpGet.path=/health/ready,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=5,failureThreshold=3 \
  --quiet

service_url="$(gcloud run services describe "$service_name" --project="$project_id" --region="$region" --format='value(status.url)')"
curl --fail --silent --show-error "${service_url}/health/live" >/dev/null
curl --fail --silent --show-error "${service_url}/health/ready" >/dev/null
printf '%s\n' "$service_url"
