#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 2
fi

environment="$1"
region="${CLOUD_BUILD_REGION:-us-central1}"
connection="uinventario-github"
artifact_repository="uinventario"

case "$environment" in
  dev)
    project_id="software-inventario-dev"
    project_number="624020863656"
    branch="develop"
    database_secret="uinventario-dev-database-url"
    ;;
  prod)
    project_id="software-inventario-prod"
    project_number="356622377746"
    branch="master"
    database_secret="uinventario-prod-database-url"
    ;;
  *)
    echo "Environment must be dev or prod." >&2
    exit 2
    ;;
esac

build_account="uinventario-cloud-build@${project_id}.iam.gserviceaccount.com"
build_member="serviceAccount:${build_account}"
cloud_build_agent="service-${project_number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"

gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project="$project_id" \
  --quiet

if ! gcloud artifacts repositories describe "$artifact_repository" --project="$project_id" --location="$region" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$artifact_repository" \
    --project="$project_id" \
    --location="$region" \
    --repository-format=docker \
    --description="UInventario deployment images" \
    --immutable-tags \
    --quiet
fi

for account in uinventario-cloud-build uinventario-api-runtime uinventario-web-runtime uinventario-backup-runtime; do
  if ! gcloud iam service-accounts describe "${account}@${project_id}.iam.gserviceaccount.com" --project="$project_id" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account" --project="$project_id" --display-name="$account" --quiet
  fi
done

if gcloud secrets describe "$database_secret" --project="$project_id" >/dev/null 2>&1; then
  gcloud secrets add-iam-policy-binding "$database_secret" \
    --project="$project_id" \
    --member="serviceAccount:uinventario-api-runtime@${project_id}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor \
    --condition=None \
    --quiet >/dev/null
  gcloud secrets add-iam-policy-binding "$database_secret" \
    --project="$project_id" \
    --member="$build_member" \
    --role=roles/secretmanager.viewer \
    --condition=None \
    --quiet >/dev/null
fi

for role in roles/logging.logWriter roles/run.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$project_id" \
    --member="$build_member" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

gcloud artifacts repositories add-iam-policy-binding "$artifact_repository" \
  --project="$project_id" \
  --location="$region" \
  --member="$build_member" \
  --role=roles/artifactregistry.writer \
  --condition=None \
  --quiet >/dev/null

source_bucket="gs://${project_id}_cloudbuild"
if gcloud storage buckets describe "$source_bucket" >/dev/null 2>&1; then
  gcloud storage buckets add-iam-policy-binding "$source_bucket" \
    --member="$build_member" \
    --role=roles/storage.objectViewer \
    --quiet >/dev/null
fi

for runtime in uinventario-api-runtime uinventario-web-runtime uinventario-backup-runtime; do
  gcloud iam service-accounts add-iam-policy-binding "${runtime}@${project_id}.iam.gserviceaccount.com" \
    --project="$project_id" \
    --member="$build_member" \
    --role=roles/iam.serviceAccountUser \
    --condition=None \
    --quiet >/dev/null
done

if ! gcloud builds connections describe "$connection" --project="$project_id" --region="$region" >/dev/null 2>&1; then
  gcloud projects add-iam-policy-binding "$project_id" \
    --member="serviceAccount:${cloud_build_agent}" \
    --role=roles/secretmanager.admin \
    --condition=None \
    --quiet >/dev/null
  gcloud builds connections create github "$connection" --project="$project_id" --region="$region" --quiet
fi

connection_stage="$(gcloud builds connections describe "$connection" --project="$project_id" --region="$region" --format='value(installationState.stage)')"
if [ "$connection_stage" != "COMPLETE" ]; then
  action_uri="$(gcloud builds connections describe "$connection" --project="$project_id" --region="$region" --format='value(installationState.actionUri)')"
  echo "GitHub authorization is pending for $project_id." >&2
  echo "Complete the non-sensitive action URI recorded in Jira UIN-19, then rerun this script." >&2
  [ -z "$action_uri" ] || printf '%s\n' "$action_uri" >&2
  exit 5
fi

gcloud projects remove-iam-policy-binding "$project_id" \
  --member="serviceAccount:${cloud_build_agent}" \
  --role=roles/secretmanager.admin \
  --condition=None \
  --quiet >/dev/null || true

for repository in uinventario-api uinventario-web; do
  if ! gcloud builds repositories describe "$repository" --project="$project_id" --region="$region" --connection="$connection" >/dev/null 2>&1; then
    gcloud builds repositories create "$repository" \
      --project="$project_id" \
      --region="$region" \
      --connection="$connection" \
      --remote-uri="https://github.com/UInventario/${repository}.git" \
      --quiet
  fi

  trigger="${repository}-${branch}"
  if ! gcloud builds triggers describe "$trigger" --project="$project_id" --region="$region" >/dev/null 2>&1; then
    gcloud builds triggers create github \
      --project="$project_id" \
      --region="$region" \
      --name="$trigger" \
      --description="UIN-24: ${branch} to ${environment} for ${repository}" \
      --repository="projects/${project_id}/locations/${region}/connections/${connection}/repositories/${repository}" \
      --branch-pattern="^${branch}$" \
      --build-config=cloudbuild.yaml \
      --service-account="projects/${project_id}/serviceAccounts/${build_account}" \
      --substitutions="_DEPLOY_ENV=${environment},_REGION=${region},_ARTIFACT_REPOSITORY=${artifact_repository}" \
      --quiet
  fi
done

printf 'Cloud Build configured: %s -> %s (%s)\n' "$branch" "$environment" "$project_id"
