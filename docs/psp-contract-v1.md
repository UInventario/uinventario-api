# PSP contract v1

`/integrations/psp/v1` exposes a tenant-admin simulator for remote payments. The versioned flow is
intent → confirmation → capture → query/reconciliation → refund. Every mutation requires an
`Idempotency-Key`; an `INDETERMINATE` capture must be queried before any capture retry.

The simulator accepts only amount, currency and merchant references. It has no cardholder fields and
does not store PAN, CVC or payment method data. Its one-time webhook token is returned only with a new
intent, stored as a SHA-256 digest, and used to verify simulator callbacks. Events are deduplicated by
tenant/provider/event ID and older states cannot regress a captured or refunded payment.

`STRIPE_COMPATIBLE` is a documented inactive profile. Activating a live adapter requires separate
per-environment and per-tenant references for an API key and webhook signing secret, a provider
sandbox, and the same v1 idempotency, reconciliation and webhook contract tests. No live credentials
are present in this repository.
