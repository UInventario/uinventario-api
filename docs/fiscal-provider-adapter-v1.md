# Fiscal provider adapter contract v1

`VersionedFiscalProviderAdapter` separates the sale domain from country authorities and providers.
Every implementation must pass `fiscalProviderAdapterContract` before it can be registered.

The contract supports issue, query, cancel and PDF/XML download. An issue timeout returns
`INDETERMINATE`; callers must query or process a deduplicated callback and must never issue again
with a new identity. Provider and operation idempotency are tenant-scoped.

The built-in `SIMULATOR` is non-production. It accepts only a safe reference, document type and
scenario; it never accepts customer, taxpayer, certificate or private-key values. Configuration
stores only Secret Manager reference names. `SUCCESS`, `REJECT` and `TIMEOUT` cover accepted,
rejected and asynchronous/indeterminate behavior.

Future SAT, SII or intermediary adapters must map their country-specific payloads at the adapter
boundary, keep generic domain statuses, sanitize observability, and implement the same suite.

## POS sale documents

A completed sale always keeps its `NON_FISCAL_SALE_RECEIPT`. Fiscal issuance creates a separate,
tenant-and-branch-scoped record linked one-to-one to that sale. Its event history persists
`PENDING`, `SENT` and the provider result; an indeterminate result must be queried or resolved by a
deduplicated callback. Retrying issuance reuses the stored provider idempotency key, so a fiscal
timeout or application restart never repeats the sale or issues blindly with a new identity.

Only accepted simulated documents expose authenticated PDF/XML paths and digital delivery. Fiscal
cancellation requires the sale-void permission. The simulator remains explicitly non-production.
