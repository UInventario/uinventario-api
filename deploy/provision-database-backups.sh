#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 2
fi

environment="$1"
region="${CLOUD_RUN_REGION:-us-central1}"

case "$environment" in
  dev)
    project_id="software-inventario-dev"
    project_number="624020863656"
    database_secret="uinventario-dev-database-url"
    retention="P1D"
    lifecycle="deploy/database-backup-lifecycle-dev.json"
    ;;
  prod)
    project_id="software-inventario-prod"
    project_number="356622377746"
    database_secret="uinventario-prod-database-url"
    retention="P7D"
    lifecycle="deploy/database-backup-lifecycle-prod.json"
    ;;
  *)
    echo "Environment must be dev or prod." >&2
    exit 2
    ;;
esac

bucket="${project_id}-uinventario-backups"
bucket_uri="gs://${bucket}"
runtime_account="uinventario-backup-runtime@${project_id}.iam.gserviceaccount.com"
build_account="uinventario-cloud-build@${project_id}.iam.gserviceaccount.com"

gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  --project="$project_id" \
  --quiet

if ! gcloud iam service-accounts describe "$runtime_account" --project="$project_id" >/dev/null 2>&1; then
  gcloud iam service-accounts create uinventario-backup-runtime \
    --project="$project_id" \
    --display-name="UInventario database backup runtime" \
    --quiet
fi

if ! gcloud storage buckets describe "$bucket_uri" >/dev/null 2>&1; then
  gcloud storage buckets create "$bucket_uri" \
    --project="$project_id" \
    --location="$region" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --retention-period="$retention" \
    --soft-delete-duration=0 \
    --quiet
fi

gcloud storage buckets update "$bucket_uri" \
  --default-storage-class=STANDARD \
  --lifecycle-file="$lifecycle" \
  --public-access-prevention \
  --retention-period="$retention" \
  --soft-delete-duration=0 \
  --uniform-bucket-level-access \
  --quiet

attempt=1
while ! gcloud secrets add-iam-policy-binding "$database_secret" \
    --project="$project_id" \
    --member="serviceAccount:${runtime_account}" \
    --role=roles/secretmanager.secretAccessor \
    --condition=None \
    --quiet >/dev/null 2>&1; do
  if [ "$attempt" -ge 6 ]; then
    echo "Could not grant database secret access after IAM propagation retries." >&2
    exit 4
  fi
  attempt=$((attempt + 1))
  sleep 5
done

for role in roles/storage.objectCreator roles/storage.objectViewer; do
  gcloud storage buckets add-iam-policy-binding "$bucket_uri" \
    --member="serviceAccount:${runtime_account}" \
    --role="$role" \
    --quiet >/dev/null
done

gcloud iam service-accounts add-iam-policy-binding "$runtime_account" \
  --project="$project_id" \
  --member="serviceAccount:${build_account}" \
  --role=roles/iam.serviceAccountUser \
  --condition=None \
  --quiet >/dev/null

for job in uinventario-database-backup uinventario-database-restore-drill; do
  if gcloud run jobs describe "$job" --project="$project_id" --region="$region" >/dev/null 2>&1; then
    gcloud run jobs add-iam-policy-binding "$job" \
      --project="$project_id" \
      --region="$region" \
      --member="serviceAccount:${runtime_account}" \
      --role=roles/run.invoker \
      --quiet >/dev/null
  fi
done

backup_uri="https://run.googleapis.com/v2/projects/${project_number}/locations/${region}/jobs/uinventario-database-backup:run"
restore_uri="https://run.googleapis.com/v2/projects/${project_number}/locations/${region}/jobs/uinventario-database-restore-drill:run"

upsert_schedule() {
  name="$1"
  schedule="$2"
  uri="$3"
  description="$4"
  if gcloud scheduler jobs describe "$name" --project="$project_id" --location="$region" >/dev/null 2>&1; then
    command="update"
  else
    command="create"
  fi
  gcloud scheduler jobs "$command" http "$name" \
    --project="$project_id" \
    --location="$region" \
    --schedule="$schedule" \
    --time-zone=Etc/UTC \
    --uri="$uri" \
    --http-method=POST \
    --oauth-service-account-email="$runtime_account" \
    --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
    --message-body='{}' \
    --attempt-deadline=180s \
    --max-retry-attempts=2 \
    --description="$description" \
    --quiet
}

if gcloud run jobs describe uinventario-database-backup --project="$project_id" --region="$region" >/dev/null 2>&1; then
  upsert_schedule uinventario-database-backup-daily "0 3 * * *" "$backup_uri" \
    "UIN-138 daily encrypted logical backup"
  upsert_schedule uinventario-database-restore-drill-weekly "0 5 * * 0" "$restore_uri" \
    "UIN-138 weekly isolated restore verification"
else
  echo "Backup jobs are not deployed yet; rerun after deploy/database-backup-jobs.sh." >&2
fi

printf 'Database backup storage provisioned: %s (%s)\n' "$bucket_uri" "$environment"
