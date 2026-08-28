# Cost guardrails

UInventario uses an alert-first, scale-to-zero cost model. Budgets notify operators; they never stop services or mutate production automatically. The platform owner is `uinventario`.

The inventory below was reconciled on 2026-08-28 against project IDs `software-inventario-dev` (624020863656) and `software-inventario-prod` (356622377746). Neither project has the Cloud SQL, Redis, Compute Engine or GKE API enabled, so the baseline contains no untracked always-on resource from those services.

## Current inventory

| Resource | Dev | Prod | Owner | Cost control |
| --- | --- | --- | --- | --- |
| Cloud Run API | min 0, max 3, 1 CPU/512 MiB, concurrency 40 | same | `uinventario` | CPU throttled; request-driven |
| Cloud Run Web | min 0, max 3, 1 CPU/256 MiB, concurrency 80 | same | `uinventario` | CPU throttled; request-driven |
| Migration job | 1 task, no retry | same | `uinventario` | Runs only during API deploy |
| Backup job | 1 task, max 1 retry, daily | same | `uinventario` | Scheduled execution only |
| Restore drill | 1 task, no retry, weekly | same | `uinventario` | Scheduled execution only |
| Database backups | delete after 14 days; 1-day retention lock | delete after 35 days; 7-day retention lock | `uinventario` | Standard storage; soft delete disabled |
| Cloud Build sources | bucket present; delete after 14 days | no source bucket provisioned; 35-day policy is ready if created | `uinventario` | Soft delete disabled; public access prevented |
| Artifact Registry | keep at least 10 versions/package; delete versions older than 30 days | keep at least 30 versions/package; delete versions older than 180 days | `uinventario` | Active cleanup policy; mutable commit tags allow cleanup |
| `_Default` logs | 7 days | 30 days | `uinventario` | No premium log bucket or always-on agent |
| Monthly budget alert | CLP 5,000 | CLP 15,000 | billing IAM + project owners | 50% actual, 90% forecast, 100% actual; alert-only |

These are guardrail envelopes, not invoice forecasts. With no traffic, Cloud Run services have no provisioned instances. Remaining variable cost comes from requests, builds, short-lived jobs and retained storage.

## Expensive dependencies

No Cloud SQL, Memorystore/Redis, GKE cluster, VM, broker or paid observability service is part of the supported baseline. The application database is externally supplied through the environment-specific Secret Manager entry established by UIN-27. A new always-on or paid third-party dependency requires a Jira ticket prefixed `[USER ACTION]` with provider, expected minimum capacity, pricing decision, secret names and affected Stories; secrets must never be placed in Jira or Git.

## Apply and verify

From `uinventario-api`, using an operator identity with project and Billing Budget permissions:

```sh
sh deploy/configure-cost-guardrails.sh dev
sh deploy/configure-cost-guardrails.sh prod
python deploy/manage-budget.py verify dev
python deploy/manage-budget.py verify prod
python deploy/verify-cost-guardrails.py
```

The configuration script is idempotent. Artifact cleanup is asynchronous and can take approximately one day. Keep policies preserve rollback images even when a delete condition matches. Lifecycle deletion is intentional and only targets old build sources or artifacts; database backups keep their separate recovery retention.

References: [Artifact Registry cleanup policies](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy), [Cloud Billing Budget resource](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets), and [Budget create API](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets/create).
