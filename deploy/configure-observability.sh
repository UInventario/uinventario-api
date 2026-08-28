#!/usr/bin/env sh
set -eu

[ "$#" -eq 1 ] || { echo "Usage: $0 <dev|prod>" >&2; exit 2; }
environment="$1"
region="${CLOUD_RUN_REGION:-us-central1}"

case "$environment" in
  dev)
    project_id="software-inventario-dev"
    retention_days="7"
    error_threshold="5"
    ;;
  prod)
    project_id="software-inventario-prod"
    retention_days="30"
    error_threshold="1"
    ;;
  *) echo "Environment must be dev or prod." >&2; exit 2 ;;
esac

api_url="$(gcloud run services describe uinventario-api --project="$project_id" --region="$region" --format='value(status.url)')"
web_url="$(gcloud run services describe uinventario-web --project="$project_id" --region="$region" --format='value(status.url)')"
api_host="${api_url#https://}"
web_host="${web_url#https://}"

gcloud services enable logging.googleapis.com monitoring.googleapis.com \
  --project="$project_id" --quiet

gcloud logging buckets update _Default --location=global \
  --retention-days="$retention_days" --project="$project_id" --quiet

upsert_log_metric() {
  metric="$1"
  description="$2"
  filter="$3"
  if gcloud logging metrics describe "$metric" --project="$project_id" >/dev/null 2>&1; then
    gcloud logging metrics update "$metric" --project="$project_id" \
      --description="$description" --log-filter="$filter" --quiet
  else
    gcloud logging metrics create "$metric" --project="$project_id" \
      --description="$description" --log-filter="$filter" --quiet
  fi
}

upsert_log_metric uinventario_application_errors \
  "UInventario sanitized server errors" \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="uinventario-api" AND jsonPayload.event="request_completed" AND jsonPayload.outcome="server_error"'
upsert_log_metric uinventario_critical_queue_errors \
  "UInventario offline sync or integration server errors" \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="uinventario-api" AND jsonPayload.event="request_completed" AND jsonPayload.outcome="server_error" AND (jsonPayload.operation="offline_sync" OR jsonPayload.operation="integration")'

ensure_uptime() {
  display_name="$1"
  host="$2"
  path="$3"
  check_name=""
  for candidate in $(gcloud monitoring uptime list-configs --project="$project_id" --format='value(name)' | tr -d '\r'); do
    candidate_display_name="$(gcloud monitoring uptime describe "$candidate" \
      --project="$project_id" --format='value(displayName)' | tr -d '\r')"
    if [ "$candidate_display_name" = "$display_name" ]; then
      check_name="$candidate"
      break
    fi
  done
  if [ -z "$check_name" ]; then
    gcloud monitoring uptime create "$display_name" --project="$project_id" \
      --resource-type=uptime-url \
      --resource-labels="host=${host},project_id=${project_id}" \
      --path="$path" --protocol=https --request-method=get \
      --period=5 --timeout=10 --status-codes=200 --validate-ssl=true --quiet
    for candidate in $(gcloud monitoring uptime list-configs --project="$project_id" --format='value(name)' | tr -d '\r'); do
      candidate_display_name="$(gcloud monitoring uptime describe "$candidate" \
        --project="$project_id" --format='value(displayName)' | tr -d '\r')"
      if [ "$candidate_display_name" = "$display_name" ]; then
        check_name="$candidate"
        break
      fi
    done
  fi
  printf '%s\n' "${check_name##*/}"
}

api_check_id="$(ensure_uptime "UInventario ${environment} API readiness" "$api_host" /health/ready)"
web_check_id="$(ensure_uptime "UInventario ${environment} Web availability" "$web_host" /health/live)"

policy_exists() {
  expected_display_name="$1"
  for candidate in $(gcloud monitoring policies list --project="$project_id" --format='value(name)' | tr -d '\r'); do
    candidate_display_name="$(gcloud monitoring policies describe "$candidate" \
      --project="$project_id" --format='value(displayName)' | tr -d '\r')"
    if [ "$candidate_display_name" = "$expected_display_name" ]; then return 0; fi
  done
  return 1
}

create_threshold_policy() {
  display_name="$1"
  condition_name="$2"
  filter="$3"
  comparison="$4"
  duration="$5"
  aggregation="$6"
  documentation="$7"
  if policy_exists "$display_name"; then return; fi
  gcloud monitoring policies create --project="$project_id" \
    --display-name="$display_name" \
    --combiner=OR \
    --condition-display-name="$condition_name" \
    --condition-filter="$filter" \
    --aggregation="$aggregation" \
    --if="$comparison" --duration="$duration" --trigger-count=1 \
    --documentation="$documentation" --documentation-format=text/markdown \
    --user-labels="app=uinventario,environment=${environment}" --quiet
}

create_threshold_policy \
  "UInventario ${environment} API availability" \
  "API readiness below 99% for 5 minutes" \
  "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${api_check_id}\"" \
  "< 0.99" 300s \
  '{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_FRACTION_TRUE"}' \
  "Check /health/ready and the database dependency; follow the production runbook."

create_threshold_policy \
  "UInventario ${environment} Web availability" \
  "Web availability below 99% for 5 minutes" \
  "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${web_check_id}\"" \
  "< 0.99" 300s \
  '{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_FRACTION_TRUE"}' \
  "Check /health/live and the Web revision; follow the production runbook."

create_threshold_policy \
  "UInventario ${environment} API server errors" \
  "Sanitized server error rate exceeds budget" \
  "metric.type=\"logging.googleapis.com/user/uinventario_application_errors\" AND resource.type=\"cloud_run_revision\"" \
  "> ${error_threshold}" 0s \
  '{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM","crossSeriesReducer":"REDUCE_SUM"}' \
  "Inspect request_completed events by correlationId and tenantRef; never paste secrets into incidents."

create_threshold_policy \
  "UInventario ${environment} API p95 latency" \
  "API p95 latency exceeds two seconds" \
  "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"uinventario-api\"" \
  "> 2000" 300s \
  '{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_PERCENTILE_95","crossSeriesReducer":"REDUCE_MAX"}' \
  "Inspect Cloud Run saturation and correlated request logs before changing instance limits."

create_threshold_policy \
  "UInventario ${environment} critical queues" \
  "Offline sync or integration server error detected" \
  "metric.type=\"logging.googleapis.com/user/uinventario_critical_queue_errors\" AND resource.type=\"cloud_run_revision\"" \
  "> 0" 0s \
  '{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM","crossSeriesReducer":"REDUCE_SUM"}' \
  "Inspect offline_sync/integration request events by correlationId; preserve idempotency during recovery."

printf 'Observability configured for %s (%s): retention=%s days\n' \
  "$environment" "$project_id" "$retention_days"
