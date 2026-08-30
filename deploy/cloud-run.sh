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
    email_secret="uinventario-dev-resend-config"
    observability_success_sample_rate="0.20"
    password_reset_path="/v2/restablecer"
    ;;
  prod)
    project_id="software-inventario-prod"
    database_secret="uinventario-prod-database-url"
    email_secret="uinventario-prod-resend-config"
    observability_success_sample_rate="0.05"
    password_reset_path="/restablecer"
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

email_secret_state="$(gcloud secrets versions describe latest \
  --secret="$email_secret" \
  --project="$project_id" \
  --format='value(state)' 2>/dev/null || true)"
runtime_secrets="DATABASE_URL=${database_secret}:latest"
password_reset_delivery="disabled"
if [ "$email_secret_state" = "ENABLED" ]; then
  runtime_secrets="${runtime_secrets},RESEND_CONFIG=${email_secret}:latest"
  password_reset_delivery="adapter"
else
  echo "Email provider secret $email_secret is unavailable; deploying with simulator/disabled recovery delivery. Resolve the linked USER ACTION to activate Resend."
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
  --labels="app=uinventario,environment=${environment},component=migrations,owner=uinventario" \
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
  --set-secrets="$runtime_secrets" \
  --set-env-vars="NODE_ENV=production,DEPLOY_ENV=${environment},DB_MIGRATIONS_RUN=false,CORS_ORIGINS=${web_origin},PASSWORD_RESET_PUBLIC_URL=${web_origin}${password_reset_path},PASSWORD_RESET_DELIVERY=${password_reset_delivery},EMAIL_PROVIDER_SECRET_REFERENCE=${email_secret},OBSERVABILITY_SUCCESS_SAMPLE_RATE=${observability_success_sample_rate}" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --cpu-throttling \
  --concurrency=40 \
  --min=0 \
  --max=3 \
  --timeout=60s \
  --labels="app=uinventario,environment=${environment},component=api,owner=uinventario" \
  --startup-probe=httpGet.path=/health/live,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=3,failureThreshold=20 \
  --liveness-probe=httpGet.path=/health/live,initialDelaySeconds=10,timeoutSeconds=3,periodSeconds=30,failureThreshold=3 \
  --readiness-probe=httpGet.path=/health/ready,timeoutSeconds=3,periodSeconds=5,failureThreshold=3 \
  --quiet

service_url="$(gcloud run services describe "$service_name" --project="$project_id" --region="$region" --format='value(status.url)')"
curl --fail --silent --show-error "${service_url}/health/live" >/dev/null
curl --fail --silent --show-error "${service_url}/health/ready" >/dev/null
printf '%s\n' "$service_url"
