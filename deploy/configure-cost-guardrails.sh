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
    artifact_policy="deploy/artifact-cleanup-dev.json"
    cloud_build_lifecycle="deploy/cloud-build-lifecycle-dev.json"
    ;;
  prod)
    project_id="software-inventario-prod"
    artifact_policy="deploy/artifact-cleanup-prod.json"
    cloud_build_lifecycle="deploy/cloud-build-lifecycle-prod.json"
    ;;
  *)
    echo "Environment must be dev or prod." >&2
    exit 2
    ;;
esac

gcloud services enable billingbudgets.googleapis.com cloudbilling.googleapis.com \
  --project="$project_id" --quiet

# Commit SHA tags are intentionally mutable so old images can be deleted. The
# pipeline still refuses to overwrite an existing commit tag before pushing.
gcloud artifacts repositories update uinventario \
  --project="$project_id" \
  --location="$region" \
  --no-immutable-tags \
  --update-labels="app=uinventario,environment=${environment},owner=uinventario" \
  --quiet
gcloud artifacts repositories set-cleanup-policies uinventario \
  --project="$project_id" \
  --location="$region" \
  --policy="$artifact_policy" \
  --no-dry-run \
  --quiet

source_bucket="gs://${project_id}_cloudbuild"
if gcloud storage buckets describe "$source_bucket" >/dev/null 2>&1; then
  gcloud storage buckets update "$source_bucket" \
    --lifecycle-file="$cloud_build_lifecycle" \
    --clear-soft-delete \
    --public-access-prevention \
    --update-labels="app=uinventario,environment=${environment},owner=uinventario,component=cloud-build-source" \
    --quiet
else
  printf 'Cloud Build source bucket is not provisioned in %s; no retained source objects.\n' "$project_id"
fi

backup_bucket="gs://${project_id}-uinventario-backups"
gcloud storage buckets update "$backup_bucket" \
  --update-labels="app=uinventario,environment=${environment},owner=uinventario,component=database-backups" \
  --quiet

python deploy/manage-budget.py apply "$environment"
printf 'Cost guardrails configured for %s (%s).\n' "$environment" "$project_id"
