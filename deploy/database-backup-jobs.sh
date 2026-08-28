#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <dev|prod> <container-image>" >&2
  exit 2
fi

environment="$1"
image="$2"
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
  *)
    echo "Environment must be dev or prod." >&2
    exit 2
    ;;
esac

case "$image" in
  *.pkg.dev/"$project_id"/*:*) ;;
  *)
    echo "Backup image must be a tagged Artifact Registry image in $project_id." >&2
    exit 2
    ;;
esac

bucket="${project_id}-uinventario-backups"
bucket_uri="gs://${bucket}"
runtime_account="uinventario-backup-runtime@${project_id}.iam.gserviceaccount.com"

if ! gcloud storage buckets describe "$bucket_uri" >/dev/null 2>&1; then
  echo "Backup bucket is missing. Run deploy/provision-database-backups.sh $environment first." >&2
  exit 3
fi
if ! gcloud iam service-accounts describe "$runtime_account" --project="$project_id" >/dev/null 2>&1; then
  echo "Backup runtime account is missing. Provision UIN-138 first." >&2
  exit 3
fi
if [ "$(gcloud secrets versions describe latest --secret="$database_secret" --project="$project_id" --format='value(state)' 2>/dev/null || true)" != "ENABLED" ]; then
  echo "Database secret has no enabled latest version in $project_id." >&2
  exit 3
fi

deploy_job() {
  name="$1"
  operation="$2"
  retries="$3"
  gcloud run jobs deploy "$name" \
    --project="$project_id" \
    --region="$region" \
    --image="$image" \
    --service-account="$runtime_account" \
    --args="$operation" \
    --set-secrets="DATABASE_URL=${database_secret}:latest" \
    --set-env-vars="DEPLOY_ENV=${environment},BACKUP_BUCKET=${bucket}" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries="$retries" \
    --task-timeout=30m \
    --cpu=1 \
    --memory=512Mi \
    --labels="app=uinventario,environment=${environment},component=database-recovery" \
    --quiet
}

deploy_job uinventario-database-backup backup 1
deploy_job uinventario-database-restore-drill restore-drill 0

printf 'Database recovery jobs deployed: %s (%s)\n' "$image" "$environment"
